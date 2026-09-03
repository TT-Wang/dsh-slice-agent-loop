import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { dbQueryTool, fetchPageTool } from '../src/bench/tools.js'

describe('bench tools', () => {
  const wd = mkdtempSync(join(tmpdir(), 'bench-tools-'))
  mkdirSync(join(wd, 'site', 'api'), { recursive: true }); mkdirSync(join(wd, 'data'))
  writeFileSync(join(wd, 'site', 'api', 'client.html'), '<html><body><h1>Client</h1><p>Connects.</p><table><tr><th>name</th><th>default</th></tr><tr><td>timeout</td><td>30</td></tr></table></body></html>')
  execFileSync('python3', ['-c', "import sqlite3; c=sqlite3.connect('" + join(wd, 'data', 'app.db') + "'); c.execute('create table t(id int, name text)'); c.executemany('insert into t values(?,?)', [(i, 'n%d' % i) for i in range(7)]); c.commit()"])
  it('fetch_page returns the whole page as text with headings and table cells', async () => {
    const out = await (fetchPageTool(wd).execute as (a: unknown, e: unknown) => Promise<string>)({ url: 'https://docs.example.com/api/client' }, {})
    expect(out).toContain('# Client'); expect(out).toContain('| timeout | 30'); expect(out).toContain('Connects.')
    await expect((fetchPageTool(wd).execute as (a: unknown, e: unknown) => Promise<string>)({ url: 'https://docs.example.com/nope' }, {})).rejects.toThrow('404')
  })
  it('db_query returns JSONL rows and a count, and refuses writes', async () => {
    const run = dbQueryTool(wd).execute as (a: unknown, e: unknown) => Promise<string>
    const out = await run({ sql: 'select * from t where id > 3 order by id' }, {})
    expect(out.trim().split('\n')).toEqual(['{"id": 4, "name": "n4"}', '{"id": 5, "name": "n5"}', '{"id": 6, "name": "n6"}', '-- 3 row(s)'])
    await expect(run({ sql: 'delete from t' }, {})).rejects.toThrow('only SELECT')
  })
})
