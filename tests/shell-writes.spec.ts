/** Which files a shell command may write: the working-set policy's recogniser (src/shell-writes.ts). */
import { describe, expect, it } from 'vitest'
import { shellWriteTargets } from '../src/shell-writes.js'

describe('shell write recognition', () => {
  it.each([
    ['echo hi > out.txt', ['out.txt']],
    ['printf x >> log/run.log', ['log/run.log']],
    ['cmd >| forced.txt', ['forced.txt']],
    ['cmd &> both.txt', ['both.txt']],
    ['cmd 2>err.txt', ['err.txt']],
    ['cmd >& all.txt', ['all.txt']],
    ['cmd <> rw.txt', ['rw.txt']],
    ['echo "quoted > not a redirect" > "my file.txt"', ['my file.txt']],
    ["echo '>' > real.txt", ['real.txt']],
    ['cmd > /dev/null 2>&1', []],
    ['cmd >&2', []],
    ['cmd 2>&1 | tee -a run.log copy.log', ['run.log', 'copy.log']],
    ["sed -i 's/a/b/' calc.py", ['calc.py']],
    ["sed -i '' -e 's/a/b/' -e 's/c/d/' a.py b.py", ['a.py', 'b.py']],
    ["sed -i.bak -f fix.sed calc.py", ['calc.py']],
    ["sed -n 's/a/b/p' calc.py", []],
    ["perl -pi -e 's/a/b/' calc.py", ['calc.py']],
    ['cp src/a.py dst/b.py', ['dst/b.py']],
    ['cp -t dir a b', []],
    ['mv old.py new.py', ['old.py', 'new.py']],
    ['rm -f build/out.o', ['build/out.o']],
    ['touch a.txt && truncate -s 0 b.txt', ['a.txt', 'b.txt']],
    ['git checkout -- calc.py', ['calc.py']],
    ['git checkout main', []],
    ['git restore --staged calc.py', ['calc.py']],
    ['FOO=1 sudo timeout 60 sed -i s/a/b/ calc.py', ['calc.py']],
    ['if [ -f x ]; then sed -i s/a/b/ x.py; fi', ['x.py']],
    ['cd "$PWD" && cat > "$PWD/notes.md" <<EOF\nline > inside\nEOF', ['$PWD/notes.md']],
    ['ls -la # > commented.txt', []],
    ['cat $(echo a > inner.txt) file', []],
    ["bash -c 'echo x > via-shell.txt'", ['via-shell.txt']],
  ])('%j writes %j', (command, expected) => {
    expect(shellWriteTargets(command)).toEqual(expected)
  })

  it('reads a here-document body as data, not as shell words', () => {
    const command = [
      "python3 - <<'PY'",
      'import calc',
      'if 3 > 2: print("compare > not a redirect")',
      'PY',
      'echo done > status.txt',
    ].join('\n')
    expect(shellWriteTargets(command)).toEqual(['status.txt'])
  })

  it('finds the paths an interpreter script writes through a write API', () => {
    const edit = [
      "cd \"$PWD\" && python3 - <<'PY'",
      'from pathlib import Path',
      "p = Path('calc.py')",
      's = p.read_text()',
      "s = s.replace('a', 'b')",
      'p.write_text(s)',
      'PY',
    ].join('\n')
    expect(shellWriteTargets(edit)).toEqual(['calc.py'])
    expect(shellWriteTargets(`python3 -c "open('out.json', 'w').write('{}')"`)).toEqual(['out.json'])
    expect(shellWriteTargets(`node -e "require('fs').writeFileSync('dist/x.js', '')"`)).toEqual(['dist/x.js'])
    // A tab-stripped body ends at its indented delimiter.
    expect(shellWriteTargets("python3 - <<-PY\n\tfrom pathlib import Path\n\tPath('t.py').write_text('')\n\tPY\necho > after.txt")).toEqual(['t.py', 'after.txt'])
  })

  it('does not count a script that only reads or a string method named replace', () => {
    const tests = [
      "python3 - <<'PY'",
      "src = open('calc.py').read()",
      "print(src.replace('a', 'b'))",
      'PY',
    ].join('\n')
    expect(shellWriteTargets(tests)).toEqual([])
    expect(shellWriteTargets('python3 -m unittest test_calc -v 2>&1 | tail -20')).toEqual([])
    expect(shellWriteTargets('python3 calc.py > /dev/null')).toEqual([])
  })

  it('does not count printing to the standard streams as a write, but still a file handle write', () => {
    expect(shellWriteTargets("python3 - <<'PY'\nimport sys\nsrc = open('calc.py').read()\nsys.stdout.write(src[:200])\nsys.stderr.write('done.\\n')\nPY")).toEqual([])
    expect(shellWriteTargets(`python3 -c "import sys; sys.stdout.buffer.write(open('calc.py', 'rb').read())"`)).toEqual([])
    expect(shellWriteTargets(`node -e "process.stdout.write(require('fs').readFileSync('calc.py', 'utf8'))"`)).toEqual([])
    expect(shellWriteTargets("python3 - <<'PY'\nimport sys\nfh = open(sys.argv[0] and 'out/report.txt', mode)\nfh.write('x')\nsys.stdout.write('ok')\nPY")).toEqual(['out/report.txt'])
  })

  it('recurses into a shell here-document and stops at a bounded depth', () => {
    expect(shellWriteTargets("bash <<'SH'\necho x > deep.txt\nSH")).toEqual(['deep.txt'])
    const nested = "bash -c \"bash -c 'bash -c \\\"bash -c \\\\\\\"echo > z.txt\\\\\\\"\\\"'\""
    expect(() => shellWriteTargets(nested)).not.toThrow()
  })

  it('tolerates unterminated quotes, substitutions and here-documents', () => {
    for (const command of ["echo 'open > x", 'echo "open > x', 'cat <<EOF > never.txt', 'echo $(unclosed > x', 'echo `unclosed > x', 'echo \\']) {
      expect(() => shellWriteTargets(command)).not.toThrow()
    }
    expect(shellWriteTargets('cat <<EOF > never.txt')).toEqual(['never.txt'])
  })
})
