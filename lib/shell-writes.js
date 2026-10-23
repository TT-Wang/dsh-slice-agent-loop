/**
 * Files a shell command may write, spelled as the command spells them.
 *
 * Best effort for the working-set policy (src/working-set.ts), never a
 * sandbox or an execution model: nothing is expanded or run. A recognised write
 * marks the file as being worked on and keeps that step raw beside the file's
 * kept view, so the raw view never silently predates a change the model made.
 * A write this does not recognise (a program that opens files by itself, a
 * glob, a variable) carries the same risk as any recorded read; the host's
 * edit guard and the KERNEL rule cover it.
 *
 * Recognised: output redirections (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`, `>& file`),
 * `tee`, in-place `sed -i` / `perl -i`, `cp` / `install` / `ln` destinations,
 * `mv`, `rm`, `unlink`, `touch`, `truncate`, `shred` operands, `git checkout` /
 * `git restore` paths, `sh|bash|zsh -c` and here-document shell bodies
 * (recursively), and interpreter scripts (`python -c`, `node -e`, a here-document
 * body, a here-string) that call a write API: every path-like string literal of
 * such a script counts. Here-document bodies are never read as shell words.
 */
const OPERATOR = /&&|\|\||;;|\|&|&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|[;&|()<>]/y;
const SEPARATORS = new Set([';', ';;', '&&', '||', '|', '|&', '&', '(', ')']);
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const REDIRECTS = new Set([...OUTPUT_REDIRECTS, '>&', '<', '<&', '<<', '<<-', '<<<']);
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'time', 'nohup', 'nice', 'stdbuf', 'builtin']);
/** Reserved words that can precede a command in a compound statement (`then sed -i …`). */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETER = /^(?:python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|ruby|perl|php)$/;
/** A script that calls one of these may write any path it names. `.replace(` alone is a string method and does not count. */
const WRITE_API = /\.write_text\s*\(|\.write_bytes\s*\(|\bopen\s*\([^)]*?['"][rbt]*[wax+][rbt+]*['"]|\.write\s*\(|\bwrite(?:File|FileSync)\s*\(|\bappendFile(?:Sync)?\s*\(|\bos\.(?:replace|rename|remove|unlink)\s*\(|\bshutil\.(?:copy\w*|move)\s*\(|\.(?:rename|unlink|touch)\s*\(|\bFile\.(?:write|open)\s*\(/;
const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const MAX_DEPTH = 3;
/** Split a command line into words and operators; here-document bodies attach to their `<<` operator. */
function lex(source) {
    const tokens = [];
    const heredocs = [];
    let awaiting;
    let word = '';
    let inWord = false;
    let quoted = false;
    const flush = () => {
        if (!inWord)
            return;
        if (awaiting) {
            heredocs.push({ op: awaiting.op, delimiter: word, strip: awaiting.strip });
            awaiting = undefined;
        }
        tokens.push({ kind: 'word', text: word });
        word = '';
        inWord = false;
        quoted = false;
    };
    /** Consume every pending here-document body after the newline at `start`; returns the next index. */
    const bodies = (start) => {
        let index = start;
        for (const pending of heredocs.splice(0)) {
            const lines = [];
            while (index < source.length) {
                const end = source.indexOf('\n', index);
                const line = source.slice(index, end < 0 ? source.length : end);
                index = end < 0 ? source.length : end + 1;
                if ((pending.strip ? line.replace(/^\t+/, '') : line) === pending.delimiter)
                    break;
                lines.push(line);
            }
            pending.op.body = lines.join('\n');
        }
        return index;
    };
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
            if (source[i + 1] !== '\n') {
                word += source[i + 1] ?? '';
                inWord = true;
            }
            i += 2;
        }
        else if (c === "'" || (c === '$' && source[i + 1] === "'")) {
            const open = c === '$' ? i + 1 : i;
            const end = source.indexOf("'", open + 1);
            word += source.slice(open + 1, end < 0 ? source.length : end);
            inWord = true;
            quoted = true;
            i = end < 0 ? source.length : end + 1;
        }
        else if (c === '"') {
            let j = i + 1;
            for (; j < source.length && source[j] !== '"'; j += 1) {
                if (source[j] === '\\' && j + 1 < source.length)
                    j += 1;
                word += source[j];
            }
            inWord = true;
            quoted = true;
            i = j + 1;
        }
        else if (c === '$' && source[i + 1] === '(') {
            // Command substitution stays one opaque word part: its inner words are not this command's operands.
            let depth = 0;
            let j = i + 1;
            for (; j < source.length; j += 1) {
                if (source[j] === '(')
                    depth += 1;
                else if (source[j] === ')' && --depth === 0)
                    break;
            }
            word += source.slice(i, j + 1);
            inWord = true;
            i = j + 1;
        }
        else if (c === '`') {
            const end = source.indexOf('`', i + 1);
            word += source.slice(i, end < 0 ? source.length : end + 1);
            inWord = true;
            i = end < 0 ? source.length : end + 1;
        }
        else if (c === '#' && !inWord) {
            const end = source.indexOf('\n', i);
            i = end < 0 ? source.length : end;
        }
        else if (c === '\n') {
            flush();
            tokens.push({ kind: 'op', text: ';' });
            i = bodies(i + 1);
        }
        else if (c === ' ' || c === '\t' || c === '\r') {
            flush();
            i += 1;
        }
        else {
            OPERATOR.lastIndex = i;
            const op = OPERATOR.exec(source)?.[0];
            if (op === undefined) {
                word += c;
                inWord = true;
                i += 1;
                continue;
            }
            // `2>file`: an unquoted all-digit word right before a redirection is its file descriptor.
            if ((op[0] === '<' || op[0] === '>') && inWord && !quoted && /^\d+$/.test(word)) {
                word = '';
                inWord = false;
            }
            else
                flush();
            const token = { kind: 'op', text: op };
            tokens.push(token);
            if (op === '<<' || op === '<<-')
                awaiting = { op: token, strip: op === '<<-' };
            i += op.length;
        }
    }
    flush();
    bodies(source.length);
    return tokens;
}
function commands(tokens) {
    const out = [];
    let current = { words: [], redirects: [] };
    const end = () => {
        if (current.words.length || current.redirects.length)
            out.push(current);
        current = { words: [], redirects: [] };
    };
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token.kind === 'word') {
            current.words.push(token.text);
            continue;
        }
        if (SEPARATORS.has(token.text)) {
            end();
            continue;
        }
        if (REDIRECTS.has(token.text)) {
            const next = tokens[i + 1];
            const target = next?.kind === 'word' ? next.text : undefined;
            if (target !== undefined)
                i += 1;
            current.redirects.push({ op: token.text, ...target === undefined ? {} : { target }, ...token.body === undefined ? {} : { body: token.body } });
        }
    }
    end();
    return out;
}
const operands = (words) => {
    const out = [];
    let options = true;
    for (const word of words) {
        if (options && word === '--') {
            options = false;
            continue;
        }
        if (options && word.startsWith('-') && word !== '-')
            continue;
        // An empty word is never a path: BSD `sed -i '' …` spells "no backup suffix" this way.
        if (word)
            out.push(word);
    }
    return out;
};
/** Options of `name` that consume the next word, so it is not mistaken for an operand. */
const VALUE_OPTIONS = {
    sed: new Set(['-e', '--expression', '-f', '--file', '-l', '--line-length']),
    perl: new Set(['-e', '-E', '-I', '-M', '-m']),
    truncate: new Set(['-s', '--size', '-r', '--reference']),
    cp: new Set(['-t', '--target-directory', '-S', '--suffix']),
    install: new Set(['-t', '--target-directory', '-m', '--mode', '-o', '--owner', '-g', '--group', '-S', '--suffix']),
    mv: new Set(['-t', '--target-directory', '-S', '--suffix']),
    timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
    env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
};
/** Drop the arguments of value-taking options; returns [operands, the values seen per option]. */
function parse(name, args) {
    const takes = VALUE_OPTIONS[name] ?? new Set();
    const kept = [];
    const values = new Map();
    for (let i = 0; i < args.length; i += 1) {
        const word = args[i];
        if (takes.has(word) && i + 1 < args.length) {
            values.set(word, [...values.get(word) ?? [], args[i + 1]]);
            i += 1;
            continue;
        }
        kept.push(word);
    }
    return { operands: operands(kept), values };
}
const basename = (word) => word.slice(word.lastIndexOf('/') + 1);
/** Strip assignments and wrapper programs: `FOO=1 sudo timeout 60 python3 …` → `python3 …`. */
function unwrap(words) {
    let rest = [...words];
    for (;;) {
        while (rest.length && (KEYWORDS.has(rest[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])))
            rest = rest.slice(1);
        const name = basename(rest[0] ?? '');
        if (WRAPPERS.has(name)) {
            rest = rest.slice(1);
            while (rest[0]?.startsWith('-'))
                rest = rest.slice(1);
            continue;
        }
        if (name === 'env') {
            rest = rest.slice(1);
            while (rest.length && (rest[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]))) {
                rest = rest.slice(VALUE_OPTIONS.env.has(rest[0]) ? 2 : 1);
            }
            continue;
        }
        if (name === 'timeout') {
            const { operands: rest2 } = parse('timeout', rest.slice(1));
            const at = rest.indexOf(rest2[0] ?? '', 1);
            rest = at < 0 ? [] : rest.slice(at + 1);
            continue;
        }
        return rest;
    }
}
/** Path-like string literals of a script that calls a write API. */
function scriptTargets(script) {
    if (!WRITE_API.test(script))
        return [];
    const out = [];
    for (const match of script.matchAll(STRING_LITERAL)) {
        const text = match[2];
        if (text.length && text.length <= 4096 && !/\s/.test(text) && /[./]/.test(text) && !text.startsWith('-'))
            out.push(text);
    }
    return out;
}
function commandTargets(command, depth) {
    const out = [];
    const stdin = [];
    for (const redirect of command.redirects) {
        const target = redirect.target;
        if (OUTPUT_REDIRECTS.has(redirect.op) && target !== undefined && !target.startsWith('&'))
            out.push(target);
        else if (redirect.op === '>&' && target !== undefined && !/^(?:\d+|-)$/.test(target))
            out.push(target);
        if (redirect.body !== undefined)
            stdin.push(redirect.body);
        if (redirect.op === '<<<' && target !== undefined)
            stdin.push(target);
    }
    const words = unwrap(command.words);
    const name = basename(words[0] ?? '');
    const args = words.slice(1);
    const inPlace = (pattern) => args.some(word => pattern.test(word));
    if (name === 'tee')
        out.push(...operands(args));
    else if (name === 'sed' && inPlace(/^(?:-[a-zA-Z]*i|--in-place)/)) {
        const parsed = parse('sed', args);
        const scripted = parsed.values.has('-e') || parsed.values.has('--expression') || parsed.values.has('-f') || parsed.values.has('--file');
        out.push(...scripted ? parsed.operands : parsed.operands.slice(1));
    }
    else if (name === 'perl' && inPlace(/^-[a-zA-Z]*i/)) {
        const parsed = parse('perl', args);
        out.push(...parsed.values.has('-e') || parsed.values.has('-E') ? parsed.operands : parsed.operands.slice(1));
    }
    else if (name === 'cp' || name === 'install' || name === 'ln') {
        const parsed = parse(name, args);
        const into = parsed.values.get('-t') ?? parsed.values.get('--target-directory');
        if (into === undefined && parsed.operands.length >= 2)
            out.push(parsed.operands.at(-1));
    }
    else if (name === 'mv' || name === 'rm' || name === 'unlink' || name === 'touch' || name === 'truncate' || name === 'shred') {
        out.push(...parse(name, args).operands);
    }
    else if (name === 'git' && (args[0] === 'checkout' || args[0] === 'restore')) {
        const dash = args.indexOf('--');
        out.push(...dash >= 0 ? args.slice(dash + 1) : args[0] === 'restore' ? operands(args.slice(1)) : []);
    }
    else if (SHELLS.has(name) && depth < MAX_DEPTH) {
        const flag = args.findIndex(word => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
        const scripts = flag >= 0 && args[flag + 1] !== undefined ? [args[flag + 1]] : stdin;
        for (const script of scripts)
            out.push(...shellWriteTargets(script, depth + 1));
    }
    else if (INTERPRETER.test(name)) {
        const flag = args.findIndex(word => word === '-c' || word === '-e' || word === '-E' || word === '--eval');
        const scripts = flag >= 0 && args[flag + 1] !== undefined ? [args[flag + 1]] : stdin;
        for (const script of scripts)
            out.push(...scriptTargets(script));
    }
    return out;
}
/**
 * Paths `command` may write, in first-mention order without duplicates, as
 * written (relative, `$PWD/…` or absolute); `/dev/*` targets are dropped. The
 * caller resolves them against paths the session already knows.
 */
export function shellWriteTargets(command, depth = 0) {
    const seen = new Set();
    for (const parsed of commands(lex(command))) {
        for (const target of commandTargets(parsed, depth)) {
            if (target && !target.startsWith('/dev/'))
                seen.add(target);
        }
    }
    return [...seen];
}
