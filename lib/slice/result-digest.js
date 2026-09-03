/**
 * result-digest.ts — 注入时摘要(insertion-time digest)。
 *
 * v3「追加流」模式的核心杠杆:成本由每步**新增字节**决定(严格前缀缓存下命中价是
 * 未命中的 1/30),所以大工具结果在进入上下文之前就折成紧凑视图;全文原样留在会话
 * 日志(recall_step 逐字取回);上下文里从此只有紧凑视图,且永不重写——append-only。
 *
 * 2026-09-03 按内容类型分路由(抄自 Headroom 的 ContentRouter / LogCompressor 思路):
 *   code   → 不折(代码是混合文本,残缺函数体会让模型编错;Headroom 同样把 Read/Edit 排除在外)
 *   search → 不折(grep/glob 的每一行都是命中,头尾视图会藏掉匹配)
 *   log    → 错误优先:ERROR/FAIL/WARN 行 + 前后 contextLines 行 + 紧随的栈帧 + 摘要行,
 *            相似行去重(保留消息前缀,归一化数字/十六进制/路径),头 3 尾 6;512 字节起折
 *   data   → 头/尾 + 结构行(`key = value` / `key: value` / 标题 / 段标记);头部区外的
 *            结构块按"键的新颖性"自适应保留(同形附录块只留前几行),1500 字符起折
 *
 * 守卫:小结果不折;折后体量 ≥ 原文 × maxKeepRatio 也不折(折了不省就别折)。
 */
export const DEFAULT_DIGEST_POLICY = {
    // minChars 1500 → 6000(2026-09-03):l2 的 3.7K 规则文档被折掉整段 R1–R9,45 个 posting 全写错目录。小文档折了
    // 省不了几个 token(3K 字符 ≈ 750 token 一次未命中)却可能丢规则;收益只在大结果上(l1 每条 18K、s13 9K)。
    enabled: true, minChars: 6000, headLines: 10, tailLines: 4, maxKeepRatio: 0.55,
    structuredBlockCap: 12, structuredBlockMin: 3,
    logMinChars: 512, logMaxErrors: 10, logContextLines: 3,
    maxLineChars: 1500, lineHeadChars: 700, lineTailChars: 300,
    jsonMinItems: 5, jsonKeepItems: 15,
    searchMinMatches: 120, searchMinChars: 10_000, searchMaxPerFile: 5, searchMaxTotal: 60,
    diffMinLines: 50, diffContextLines: 2, diffMaxHunksPerFile: 10,
};
/** 结构行:`key = value`、`key: value`、markdown/注释标题、围栏。噪音正文极少长这样。 */
// 键允许一个内部空格(`R1 path:`、`Opening balance:`):规则/说明文档的条目通常长这样。
// 表格行(markdown `| a | b |`,或 HTML 转文本后的 ` | a | b | `)也是结构行:文档里信息密度最高的部分,f9 实测折掉参数表后模型逐页取回。
const STRUCTURED = /^\s*(?:[A-Za-z_][\w.\-/]*(?: [\w.\-/]+)?\s*[=:]\s*\S|#{1,6}\s|\[[^\]]+\]\s*$|```|\|.*\|)/;
/** read 工具按 OpenCode 风格给每行加 `N: ` 前缀(grep 是 `N|`/`N:`);判结构前先剥掉。 */
const LINE_NUMBER_PREFIX = /^\s*\d+[:|]\s?/;
const strip = (line) => line.replace(LINE_NUMBER_PREFIX, '');
function isStructured(line) {
    return STRUCTURED.test(strip(line));
}
/** 结构行的键(`key = value` / `key: value` 的 key;标题/段标记整行作键)。 */
function structuredKey(line) {
    const s = strip(line).trim();
    const m = /^([A-Za-z_][\w.\-]*)\s*[=:]/.exec(s);
    return m ? m[1] : s;
}
// ---------------------------------------------------------------- content kinds
/**
 * 源代码不折:代码文件是混合文本(赋值行像结构行,逻辑行不像),折后视图会让模型对着
 * 残缺的函数体编辑——s1 复验里 store.py 折了 3 次,模型把 delete 方法编没了。按扩展名
 * 判 read 的路径;无路径的文本(bash 输出)按内容密度判:代码特征行占比 ≥ 15% 视为代码。
 */
const CODE_EXT = /\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|c|h|cc|cpp|hpp|cs|java|kt|scala|rb|php|swift|m|mm|sh|bash|zsh|fish|ps1|sql|lua|pl|r|jl|ex|exs|erl|hs|ml|clj|scm|lisp|el|vim|dart|zig|nim|v|sv|vhd|proto|thrift|tf|hcl|gradle|cmake|make|mk)$/i;
const CODE_LINE = /^\s*(?:def |class |function\b|func |fn |import |from .+ import |#include|package |return\b|if\b.*[:{]\s*$|for\b.*[:{]\s*$|while\b.*[:{]\s*$|else\b|try\b|except\b|catch\b|\}\s*$|\{\s*$|export |const |let |var |public |private |static |@\w+)/;
export function looksLikeCodePath(path) {
    return path !== undefined && CODE_EXT.test(path);
}
export function looksLikeCode(text) {
    const lines = text.split('\n').map(strip).filter((l) => l.trim() !== '');
    if (lines.length < 8)
        return false;
    const hits = lines.reduce((a, l) => a + (CODE_LINE.test(l) ? 1 : 0), 0);
    return hits >= lines.length * 0.15;
}
/** grep -n / rg 风格:`path:line:` 或 `path:line|` 开头。 */
const SEARCH_LINE = /^(?:[\w.\-~]+\/)*[\w.\-]+\.\w{1,8}:\d+[:|]|^(?:[\w.\-~]+\/)+[\w.\-]+:\d+[:|]/;
/** 日志/构建/测试输出的特征:时间戳、级别词、测试框架的行。 */
const LOG_LINE = /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\s*\[?\d{2}:\d{2}:\d{2}|\b(?:ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|PANIC|CRITICAL)\b|\b(?:PASSED|FAILED|SKIPPED|passed|failed|error\[E\d+\]|Traceback|Exception|npm (?:ERR|WARN)!|Compiling|warning:|error:)\b|^\s+at \S+ \(|^\s+File "|^(?:ok|not ok) \d|^\s*[✓✗]/;
export function detectContentKind(text, path) {
    if (looksLikeCodePath(path) || looksLikeCode(text))
        return 'code';
    const lines = text.split('\n').map(strip).filter((l) => l.trim() !== '');
    if (lines.length < 4)
        return 'data';
    const search = lines.reduce((a, l) => a + (SEARCH_LINE.test(l) ? 1 : 0), 0);
    if (search >= lines.length * 0.6)
        return 'search';
    const log = lines.reduce((a, l) => a + (LOG_LINE.test(l) ? 1 : 0), 0);
    if (log >= lines.length * 0.3)
        return 'log';
    return 'data';
}
function render(lines, keep) {
    const n = lines.length;
    const out = [];
    let i = 0;
    while (i < n) {
        if (keep.has(i)) {
            out.push(lines[i]);
            i += 1;
            continue;
        }
        let j = i;
        while (j < n && !keep.has(j))
            j += 1;
        const run = lines.slice(i, j);
        // 纯空白行的间隔不值一个省略标记(标记比空行还长):折成一个空行。
        if (run.every((l) => strip(l).trim() === '')) {
            out.push(run[0]);
            i = j;
            continue;
        }
        const elidedChars = run.reduce((a, l) => a + l.length + 1, 0);
        // 精简标记:召回指针只在视图头行给一次(digestForTrajectory 的 `[read … · recall_step(t, s)
        // returns the full text]`),每个标记不再重复——一个文件十几个标记时,标记曾占折后视图近半。
        out.push(`…[+${j - i} lines / ${elidedChars} chars]…`);
        i = j;
    }
    return out.join('\n');
}
function cutLongLine(line, policy) {
    if (!(line.length > policy.maxLineChars))
        return line;
    const head = Math.max(0, policy.lineHeadChars);
    const tail = Math.max(0, policy.lineTailChars);
    if (head + tail >= line.length)
        return line;
    return `${line.slice(0, head)} …[+${line.length - head - tail} chars]… ${tail > 0 ? line.slice(-tail) : ''}`;
}
function finish(text, lines, keep, kind, ratio) {
    const rendered = render(lines, keep);
    if (rendered.length >= text.length * ratio)
        return { text, digested: false, totalLines: lines.length, keptLines: lines.length, kind };
    return { text: rendered, digested: true, totalLines: lines.length, keptLines: keep.size, kind };
}
const untouched = (text, kind) => {
    const n = text.split('\n').length;
    return { text, digested: false, totalLines: n, keptLines: n, kind };
};
// ---------------------------------------------------------------- data digest(头/尾 + 结构行,自适应块)
export function digestData(text, policy = DEFAULT_DIGEST_POLICY) {
    if (text.length < policy.minChars)
        return untouched(text, 'data');
    // 超长行先按字符截断(头 + 标记 + 尾),再走按行的头尾/结构行逻辑;finish 用原文长度算保留比,
    // 所以只截了行也算折叠。
    const lines = text.split('\n').map((l) => cutLongLine(l, policy));
    const n = lines.length;
    const keep = new Set();
    for (let i = 0; i < Math.min(policy.headLines, n); i += 1)
        keep.add(i);
    for (let i = Math.max(0, n - policy.tailLines); i < n; i += 1)
        keep.add(i);
    // 结构块上限只针对"噪音正文里夹着附录表"的混合文件;结构行占比 ≥ 80% 的文件(配置、
    // 数据表)视为整体结构化,不设上限——留给 maxKeepRatio 守卫决定折不折。
    const structuredCount = lines.reduce((a, l) => a + (isStructured(l) ? 1 : 0), 0);
    const cap = structuredCount >= n * 0.8 ? Infinity : policy.structuredBlockCap;
    // 自适应保留(Headroom 的 anchor + dedup 思路的简化版):头部区外的结构块,每块至少留
    // structuredBlockMin 行,之后只留"键此前没出现过"的行——同形的附录块(l2 的四个
    // [prior-reconciliation])第二次起只剩前几行。上限 structuredBlockCap。
    const seenKeys = new Set();
    for (let i = 0; i < Math.min(policy.headLines, n); i += 1)
        if (isStructured(lines[i]))
            seenKeys.add(structuredKey(lines[i]));
    let kept = 0;
    for (let i = 0; i < n; i += 1) {
        if (!isStructured(lines[i])) {
            kept = 0;
            continue;
        }
        if (i < policy.headLines)
            continue;
        // 表格行不受块上限约束:一张 40 行的参数表砍到 12 行就是把模型要的东西砍掉;整页都是表时由 maxKeepRatio 兜底。
        if (/^\s*\|.*\|/.test(strip(lines[i]))) {
            keep.add(i);
            continue;
        }
        const key = structuredKey(lines[i]);
        const novel = !seenKeys.has(key);
        seenKeys.add(key);
        if (kept < cap && (kept < policy.structuredBlockMin || novel)) {
            keep.add(i);
            kept += 1;
        }
    }
    return finish(text, lines, keep, 'data', policy.maxKeepRatio);
}
// ---------------------------------------------------------------- log digest(错误优先)
const ERROR_LINE = /\b(?:ERROR|FATAL|PANIC|CRITICAL|FAIL(?:ED|URE|S)?|Traceback|Exception|AssertionError|Segmentation fault|panicked at|npm ERR!|error(?:\[E\d+\]| TS\d+)?:)\b|^\s*(?:✗|not ok|E\s{2,})|\berror\b.*\bexit code\b/i;
const WARN_LINE = /\b(?:WARN(?:ING)?|warning:|deprecat(?:ed|ion))\b/i;
const SUMMARY_LINE = /^(?:=+ .* =+|-{3,}.*-{3,}|\d+ (?:passed|failed|errors?|warnings?|tests?)\b|Tests?:|Test Suites:|FAILED \(|Ran \d+ tests?|.*\b(?:passed|failed)\b.* in \d|BUILD (?:SUCCESS|FAILED)|Finished\b|test result:|error: could not compile|\d+ problems?\b)/i;
const STACK_LINE = /^\s+(?:at \S+|File "|\.{3}|#\d+ |\w+(?:\.\w+)*\(.*\)\s*$|\S+:\d+:\d+)/;
/** 相似行去重的键:保留消息前缀(第一个 `:` / `=` 之前),其余归一化数字、十六进制、路径。 */
function dedupeKey(line) {
    const s = strip(line).trim();
    const cut = s.search(/[:=]/);
    const prefix = cut > 0 ? s.slice(0, cut) : '';
    const rest = (cut > 0 ? s.slice(cut) : s)
        .replace(/0x[0-9a-f]+/gi, 'H').replace(/\b[0-9a-f]{7,}\b/gi, 'H').replace(/\S*\/\S+/g, 'P').replace(/\d+/g, '0');
    return `${prefix.replace(/\d+/g, '0')}|${rest}`;
}
export function digestLog(text, policy = DEFAULT_DIGEST_POLICY) {
    if (text.length < policy.logMinChars)
        return untouched(text, 'log');
    const lines = text.split('\n');
    const n = lines.length;
    const level = lines.map((l) => (ERROR_LINE.test(strip(l)) ? 3 : WARN_LINE.test(strip(l)) || SUMMARY_LINE.test(strip(l)) ? 2 : 0));
    const seen = new Set();
    const errors = [];
    const warns = [];
    for (let i = 0; i < n; i += 1) {
        if (level[i] === 0)
            continue;
        const key = dedupeKey(lines[i]);
        if (seen.has(key))
            continue;
        seen.add(key);
        if (level[i] === 3)
            errors.push(i);
        else
            warns.push(i);
    }
    // Headroom LogCompressor 的选择:错误取首条 + 末条 + 前 maxErrors 条;警告/摘要取前一半配额。
    const pick = new Set();
    const first = errors.slice(0, policy.logMaxErrors);
    for (const i of first)
        pick.add(i);
    if (errors.length > 0)
        pick.add(errors[errors.length - 1]);
    for (const i of warns.slice(0, Math.max(2, Math.floor(policy.logMaxErrors / 2))))
        pick.add(i);
    if (warns.length > 0)
        pick.add(warns[warns.length - 1]);
    const keep = new Set();
    for (let i = 0; i < Math.min(3, n); i += 1)
        keep.add(i);
    for (let i = Math.max(0, n - 6); i < n; i += 1)
        keep.add(i);
    for (const i of pick) {
        for (let k = Math.max(0, i - policy.logContextLines); k <= Math.min(n - 1, i + policy.logContextLines); k += 1)
            keep.add(k);
        // 紧随错误行的栈帧整段保留(链式异常里的空行不终止)。
        if (level[i] === 3) {
            let k = i + 1;
            while (k < n && (STACK_LINE.test(lines[k]) || strip(lines[k]).trim() === '')) {
                keep.add(k);
                k += 1;
            }
        }
    }
    const r = finish(text, lines, keep, 'log', policy.maxKeepRatio);
    if (!r.digested)
        return r;
    // Headroom LogCompressor 的全局省略标记:没展示的错误/警告行各有多少——模型据此决定要不要 expand。
    let hiddenErrors = 0;
    let hiddenWarns = 0;
    for (let i = 0; i < n; i += 1)
        if (!keep.has(i)) {
            if (level[i] === 3)
                hiddenErrors += 1;
            else if (level[i] === 2)
                hiddenWarns += 1;
        }
    if (hiddenErrors + hiddenWarns > 0)
        r.text += `\n[${n - keep.size} lines omitted: ${hiddenErrors} more error lines, ${hiddenWarns} more warning/summary lines]`;
    return r;
}
// ---------------------------------------------------------------- entry points
/** 兼容入口:按 data 规则折(旧调用方与测试)。 */
export function digestText(text, _recallHint, policy = DEFAULT_DIGEST_POLICY) {
    return digestData(text, policy);
}
/** 工具结果入口:按工具名与内容类型路由。 */
export function digestToolResult(text, source, policy = DEFAULT_DIGEST_POLICY) {
    if (source.tool === 'recall_step' || source.tool === 'recall_turn' || source.tool === 'recall_search' || source.tool === 'expand_result')
        return untouched(text, 'search');
    // grep/glob:每一行都是命中,小结果原样;巨量命中才按文件配额压(Headroom SearchCompressor)。
    if (source.tool === 'grep' || source.tool === 'glob')
        return digestSearch(text, policy);
    // 统一 diff(git diff / diff -u 的输出)按 hunk 压,不走代码不折的分支。
    if (looksLikeDiff(text))
        return digestDiff(text, policy);
    // JSON / JSONL 工具结果(API 响应、清单):按元素压,而不是按行——美化 JSON 的每一行都像结构行,按行永远折不动。
    const json = tryJsonItems(text);
    if (json !== null)
        return digestJson(text, json, policy);
    // 文件读取按"文档"处理:文件里夹着的部署日志/历史记录不改变它是文档的事实(l1 节点
    // 的字段在头部,走 log 规则会把它们折掉);只有 bash 等命令输出才按内容判 log/search。
    // fetch_page 返回整页文本,按文档处理(标题/表格行是结构行);db_query 返回 JSONL,走上面的 JSON 分支。
    const isFileRead = source.tool === 'read' || source.tool === 'read_file' || source.tool === 'read_section' || source.tool === 'fetch_page';
    const kind = isFileRead
        ? (looksLikeCodePath(source.path) || looksLikeCode(text) ? 'code' : 'data')
        : detectContentKind(text, source.path);
    if (kind === 'code')
        return untouched(text, kind);
    if (kind === 'search')
        return digestSearch(text, policy);
    if (kind === 'log')
        return digestLog(text, policy);
    return digestData(text, policy);
}
/** 文本是 JSON 数组 / 含大数组字段的 JSON 对象 / JSONL 吗?是就给出元素列表。 */
export function tryJsonItems(text) {
    const t = text.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
        try {
            const v = JSON.parse(t);
            if (Array.isArray(v))
                return { kind: 'array', items: v, wrap: null };
        }
        catch { /* not json */ }
        return null;
    }
    if (t.startsWith('{') && t.endsWith('}')) {
        try {
            const v = JSON.parse(t);
            if (typeof v !== 'object' || v === null || Array.isArray(v))
                return null;
            let best = null;
            for (const [k, val] of Object.entries(v))
                if (Array.isArray(val) && (best === null || val.length > best.len))
                    best = { key: k, len: val.length };
            if (best !== null && best.len >= 2)
                return { kind: 'object', items: v[best.key], wrap: { obj: v, key: best.key } };
        }
        catch { /* not json */ }
        return null;
    }
    // JSONL:每一非空行都是一个 JSON 值
    const lines = t.split('\n').filter((l) => l.trim() !== '');
    if (lines.length >= 3 && lines.every((l) => /^\s*[\[{]/.test(l))) {
        const items = [];
        for (const l of lines) {
            try {
                items.push(JSON.parse(l));
            }
            catch {
                return null;
            }
        }
        return { kind: 'jsonl', items, wrap: null };
    }
    return null;
}
const ERRORISH = /error|fail|exception|fatal|denied|timeout|invalid|panic/i;
function itemLooksLikeError(item) {
    if (typeof item !== 'object' || item === null)
        return false;
    for (const [k, v] of Object.entries(item)) {
        if (ERRORISH.test(k) && v !== null && v !== false && v !== 0 && v !== '')
            return true;
        if (typeof v === 'string' && v.length < 200 && ERRORISH.test(v))
            return true;
        if ((k === 'status' || k === 'statusCode' || k === 'code') && typeof v === 'number' && v >= 400)
            return true;
        if (k === 'level' && typeof v === 'string' && /error|fatal|warn/i.test(v))
            return true;
    }
    return false;
}
export function digestJson(text, json, policy = DEFAULT_DIGEST_POLICY) {
    const items = json.items;
    const n = items.length;
    const totalLines = text.split('\n').length;
    if (text.length < policy.minChars || n < policy.jsonMinItems)
        return { text, digested: false, totalLines, keptLines: totalLines, kind: 'json' };
    // 去重(内容相同的元素只留第一个)
    const seen = new Set();
    const uniq = [];
    for (let i = 0; i < n; i += 1) {
        const k = JSON.stringify(items[i]);
        if (!seen.has(k)) {
            seen.add(k);
            uniq.push(i);
        }
    }
    const K = policy.jsonKeepItems;
    const keep = new Set();
    const head = Math.max(1, Math.ceil(K * 0.3));
    const tail = Math.max(1, Math.ceil(K * 0.15));
    for (const i of uniq.slice(0, head))
        keep.add(i);
    for (const i of uniq.slice(-tail))
        keep.add(i);
    for (const i of uniq) {
        if (keep.size >= K)
            break;
        if (itemLooksLikeError(items[i]))
            keep.add(i);
    }
    if (keep.size >= n)
        return { text, digested: false, totalLines, keptLines: totalLines, kind: 'json' };
    const fields = new Set();
    for (const it of items)
        if (typeof it === 'object' && it !== null && !Array.isArray(it))
            for (const k of Object.keys(it))
                fields.add(k);
    const fieldNote = fields.size > 0 ? `; fields: ${[...fields].slice(0, 12).join(', ')}${fields.size > 12 ? ', …' : ''}` : '';
    const dupNote = uniq.length < n ? `, ${n - uniq.length} duplicates` : '';
    const out = [];
    let omitted = 0;
    const flush = () => { if (omitted > 0) {
        out.push(`…[+${omitted} of ${n} items omitted${dupNote}${fieldNote}]…`);
        omitted = 0;
    } };
    const sortedKeep = [...keep].sort((a, b) => a - b);
    let cursor = 0;
    for (const i of sortedKeep) {
        omitted += i - cursor;
        flush();
        out.push(JSON.stringify(items[i]));
        cursor = i + 1;
    }
    omitted += n - cursor;
    flush();
    let rendered;
    if (json.kind === 'jsonl')
        rendered = out.join('\n');
    else if (json.kind === 'array')
        rendered = `[\n${out.join(',\n')}\n]`;
    else {
        const rest = { ...json.wrap.obj };
        delete rest[json.wrap.key];
        rendered = `${JSON.stringify(rest)}\n"${json.wrap.key}": [\n${out.join(',\n')}\n]`;
    }
    if (rendered.length >= text.length * policy.maxKeepRatio)
        return { text, digested: false, totalLines, keptLines: totalLines, kind: 'json' };
    return { text: rendered, digested: true, totalLines, keptLines: rendered.split('\n').length, kind: 'json' };
}
// ---------------------------------------------------------------- search digest(Headroom SearchCompressor:每文件配额,首末必留)
const MATCH_LINE = /^((?:[\w.\-~]+\/)*[\w.\-]+):(\d+)[:|]/;
export function digestSearch(text, policy = DEFAULT_DIGEST_POLICY) {
    const lines = text.split('\n');
    const n = lines.length;
    const byFile = new Map();
    for (let i = 0; i < n; i += 1) {
        const m = MATCH_LINE.exec(lines[i]);
        if (m) {
            const arr = byFile.get(m[1]) ?? [];
            arr.push(i);
            byFile.set(m[1], arr);
        }
    }
    const matches = [...byFile.values()].reduce((a, v) => a + v.length, 0);
    if (matches < policy.searchMinMatches && text.length < policy.searchMinChars)
        return untouched(text, 'search');
    if (matches === 0)
        return untouched(text, 'search');
    const keep = new Set();
    for (let i = 0; i < n; i += 1)
        if (!MATCH_LINE.test(lines[i]))
            keep.add(i); // 非命中行(标题、分隔)照留
    let total = 0;
    const dropped = new Map();
    for (const [file, idx] of byFile) {
        const quota = Math.max(2, policy.searchMaxPerFile);
        const pick = idx.length <= quota ? idx : [...idx.slice(0, quota - 1), idx[idx.length - 1]];
        for (const i of pick) {
            if (total < policy.searchMaxTotal) {
                keep.add(i);
                total += 1;
            }
        }
        const kept = pick.filter((i) => keep.has(i)).length;
        if (kept < idx.length)
            dropped.set(file, idx.length - kept);
    }
    if (dropped.size === 0)
        return untouched(text, 'search');
    const out = [];
    const lastKeptOfFile = new Map();
    for (const [file, idx] of byFile)
        for (const i of idx)
            if (keep.has(i))
                lastKeptOfFile.set(file, i);
    for (let i = 0; i < n; i += 1) {
        if (!keep.has(i))
            continue;
        out.push(lines[i]);
        const m = MATCH_LINE.exec(lines[i]);
        if (m && lastKeptOfFile.get(m[1]) === i && dropped.has(m[1]))
            out.push(`[... and ${dropped.get(m[1])} more matches in ${m[1]}]`);
    }
    const rendered = out.join('\n');
    if (rendered.length >= text.length * policy.maxKeepRatio)
        return untouched(text, 'search');
    return { text: rendered, digested: true, totalLines: n, keptLines: out.length, kind: 'search' };
}
// ---------------------------------------------------------------- diff digest(Headroom DiffCompressor:留头、留改动、上下文各 2 行、hunk 配额)
export function looksLikeDiff(text) {
    const head = text.slice(0, 4000);
    return /^diff --(?:git|combined|cc) /m.test(head) || (/^--- \S/m.test(head) && /^\+\+\+ \S/m.test(head) && /^@@ /m.test(head));
}
export function digestDiff(text, policy = DEFAULT_DIGEST_POLICY) {
    const lines = text.split('\n');
    const n = lines.length;
    if (n < policy.diffMinLines)
        return { text, digested: false, totalLines: n, keptLines: n, kind: 'diff' };
    // 切 hunk:每个 @@ 到下一个 @@ / 文件头之前
    const keep = new Set();
    const isHeader = (l) => /^(?:diff --|index |--- |\+\+\+ |rename |similarity |dissimilarity |copy |new file|deleted file|old mode|new mode|Binary files)/.test(l);
    const hunkStarts = [];
    for (let i = 0; i < n; i += 1) {
        if (isHeader(lines[i]))
            keep.add(i);
        if (lines[i].startsWith('@@ '))
            hunkStarts.push(i);
    }
    // 文件头之前的内容(提交信息)原样
    const firstHeader = lines.findIndex((l) => isHeader(l) || l.startsWith('@@ '));
    for (let i = 0; i < Math.max(0, firstHeader); i += 1)
        keep.add(i);
    const hunks = [];
    let fileNo = -1;
    for (let i = 0; i < n; i += 1)
        if (lines[i].startsWith('diff --'))
            fileNo += 1;
    let fno = -1;
    for (let h = 0; h < hunkStarts.length; h += 1) {
        const start = hunkStarts[h];
        let end = h + 1 < hunkStarts.length ? hunkStarts[h + 1] : n;
        for (let i = start + 1; i < end; i += 1)
            if (isHeader(lines[i])) {
                end = i;
                break;
            }
        while (fno + 1 <= fileNo && lines.slice(0, start).filter((l) => l.startsWith('diff --')).length > fno + 1)
            fno += 1;
        let changes = 0;
        for (let i = start + 1; i < end; i += 1)
            if (/^[+-]/.test(lines[i]) && !/^(?:---|\+\+\+) /.test(lines[i]))
                changes += 1;
        hunks.push({ start, end, changes, file: fno });
    }
    // 每文件 hunk 配额:首、末与改动最多的
    const byFile = new Map();
    for (const hk of hunks) {
        const arr = byFile.get(hk.file) ?? [];
        arr.push(hk);
        byFile.set(hk.file, arr);
    }
    const chosen = new Set();
    const droppedHunks = new Map();
    for (const [file, arr] of byFile) {
        if (arr.length <= policy.diffMaxHunksPerFile) {
            for (const hk of arr)
                chosen.add(hk);
            continue;
        }
        const pick = new Set([arr[0], arr[arr.length - 1]]);
        for (const hk of [...arr].sort((a, b) => b.changes - a.changes)) {
            if (pick.size >= policy.diffMaxHunksPerFile)
                break;
            pick.add(hk);
        }
        for (const hk of pick)
            chosen.add(hk);
        droppedHunks.set(file, arr.length - pick.size);
    }
    for (const hk of chosen) {
        keep.add(hk.start);
        for (let i = hk.start + 1; i < hk.end; i += 1) {
            const l = lines[i];
            if (/^[+-]/.test(l) || l.startsWith('\\ No newline')) {
                keep.add(i);
                for (let k = Math.max(hk.start + 1, i - policy.diffContextLines); k <= Math.min(hk.end - 1, i + policy.diffContextLines); k += 1)
                    keep.add(k);
            }
        }
    }
    if (keep.size >= n)
        return { text, digested: false, totalLines: n, keptLines: n, kind: 'diff' };
    const out = [];
    let i = 0;
    while (i < n) {
        if (keep.has(i)) {
            out.push(lines[i]);
            i += 1;
            continue;
        }
        let j = i;
        while (j < n && !keep.has(j))
            j += 1;
        out.push(`…[+${j - i} lines]…`);
        i = j;
    }
    for (const [file, cnt] of droppedHunks)
        out.push(`[... and ${cnt} more hunks in file #${file + 1}]`);
    const rendered = out.join('\n');
    if (rendered.length >= text.length * policy.maxKeepRatio)
        return { text, digested: false, totalLines: n, keptLines: n, kind: 'diff' };
    return { text: rendered, digested: true, totalLines: n, keptLines: out.length, kind: 'diff' };
}
export function resolveDigestPolicy(input) {
    const p = { ...DEFAULT_DIGEST_POLICY, ...(input ?? {}) };
    if (!Number.isInteger(p.minChars) || p.minChars < 0)
        throw new Error('digest.minChars must be a non-negative integer');
    if (!Number.isInteger(p.logMinChars) || p.logMinChars < 0)
        throw new Error('digest.logMinChars must be a non-negative integer');
    if (!(p.maxLineChars > 0))
        throw new Error('digest.maxLineChars must be > 0 (Infinity = never cut)');
    for (const k of ['jsonMinItems', 'jsonKeepItems', 'searchMinMatches', 'searchMinChars', 'searchMaxPerFile', 'searchMaxTotal', 'diffMinLines', 'diffContextLines', 'diffMaxHunksPerFile'])
        if (!(p[k] >= 0))
            throw new Error(`digest.${k} must be >= 0`);
    if (!Number.isInteger(p.lineHeadChars) || p.lineHeadChars < 0 || !Number.isInteger(p.lineTailChars) || p.lineTailChars < 0)
        throw new Error('digest.lineHeadChars/lineTailChars must be non-negative integers');
    if (!Number.isInteger(p.headLines) || p.headLines < 0 || !Number.isInteger(p.tailLines) || p.tailLines < 0)
        throw new Error('digest.headLines/tailLines must be non-negative integers');
    if (!(p.maxKeepRatio > 0 && p.maxKeepRatio <= 1))
        throw new Error('digest.maxKeepRatio must be in (0, 1]');
    if (!(p.structuredBlockCap >= 1))
        throw new Error('digest.structuredBlockCap must be >= 1 (Infinity = no cap)');
    if (!Number.isInteger(p.structuredBlockMin) || p.structuredBlockMin < 0)
        throw new Error('digest.structuredBlockMin must be a non-negative integer');
    if (!Number.isInteger(p.logMaxErrors) || p.logMaxErrors < 1 || !Number.isInteger(p.logContextLines) || p.logContextLines < 0)
        throw new Error('digest.logMaxErrors/logContextLines invalid');
    if (typeof p.enabled !== 'boolean')
        throw new Error('digest.enabled must be a boolean');
    return p;
}
