/**
 * bench-tools — 评测用的两个"一次给一整份"的工具(2026-09-04):
 *   fetch_page(url)  从工作目录 site/ 里取整页文本(离线、确定性;HTML 去标签),形状同网页抓取工具;
 *   db_query(sql)    对工作目录 data/*.db(SQLite)执行 SQL,整份结果按 JSONL 返回(每行一个对象),形状同数据库/MCP 查询工具。
 * 两者都接不了 `| grep`——这是折叠真正起作用的工具形状;shell 输出模型会自己过滤。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';
const MAX_ROWS = 5000;
function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|section|article|pre|blockquote)>/gi, '\n')
        .replace(/<(h[1-6])[^>]*>/gi, (m, h) => '#'.repeat(Number(h[1])) + ' ')
        .replace(/<li[^>]*>/gi, '- ').replace(/<t[dh][^>]*>/gi, ' | ').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
export function fetchPageTool(workdir) {
    return defineTool({
        name: 'fetch_page',
        description: 'Fetch a web page and return its full text content (HTML converted to plain text, headings kept as # lines, tables as | cells |). Pages under https://docs.example.com/... are served from the local documentation mirror; the whole page is returned, there is no way to fetch part of it.',
        parameters: { url: { type: 'string', required: true, description: 'Absolute URL, e.g. https://docs.example.com/api/client' } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async (args, _exec) => {
            const url = String(args?.url ?? '');
            const m = /^https?:\/\/[^/]+\/?(.*)$/.exec(url);
            if (!m)
                throw new Error(`fetch_page: not an absolute URL: ${url}`);
            const rel = normalize(m[1].replace(/[?#].*$/, '').replace(/\/+$/, '') || 'index');
            if (rel.startsWith('..'))
                throw new Error('fetch_page: invalid path');
            const site = join(workdir, 'site');
            for (const cand of [rel, rel + '.html', rel + '.md', rel + '.txt', join(rel, 'index.html'), join(rel, 'index.md')]) {
                const p = join(site, cand);
                if (existsSync(p) && !readdirSafe(p)) {
                    const raw = readFileSync(p, 'utf8');
                    return `# ${url}\n\n` + (cand.endsWith('.html') ? htmlToText(raw) : raw);
                }
            }
            throw new Error(`fetch_page: 404 for ${url}`);
        },
    });
}
function readdirSafe(p) { try {
    readdirSync(p);
    return true;
}
catch {
    return false;
} }
export function dbQueryTool(workdir) {
    return defineTool({
        name: 'db_query',
        description: 'Run a read-only SQL query against the application database (SQLite; the file under data/ named in the task). Returns every row of the result as JSON, one object per line (up to 5000 rows), followed by a row count. There is no paging: whatever the query returns comes back whole, so shape the query for what you need.',
        parameters: { sql: { type: 'string', required: true, description: 'A single SELECT / PRAGMA / EXPLAIN statement.' }, db: { type: 'string', description: 'Database file relative to the workspace (default: the only .db under data/).' } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async (args, _exec) => {
            const a = args;
            const sql = String(a?.sql ?? '').trim();
            if (!/^(select|with|pragma|explain)\b/i.test(sql))
                throw new Error('db_query: only SELECT / WITH / PRAGMA / EXPLAIN statements are allowed');
            let db = typeof a.db === 'string' ? a.db : '';
            if (!db) {
                const dir = join(workdir, 'data');
                const dbs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
                if (dbs.length !== 1)
                    throw new Error(`db_query: pass db= (found ${dbs.length} .db files under data/)`);
                db = join('data', dbs[0]);
            }
            const py = `import sqlite3, json, sys
con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
cur = con.execute(sys.argv[2])
rows = cur.fetchmany(${MAX_ROWS + 1})
out = [json.dumps({k: r[k] for k in r.keys()}, ensure_ascii=False) for r in rows[:${MAX_ROWS}]]
print('\\n'.join(out))
print('-- %d row(s)%s' % (min(len(rows), ${MAX_ROWS}), ' (truncated at ${MAX_ROWS})' if len(rows) > ${MAX_ROWS} else ''))`;
            try {
                return execFileSync('python3', ['-c', py, join(workdir, db), sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            }
            catch (e) {
                const err = e;
                throw new Error(`db_query: ${(err.stderr ?? err.message ?? String(e)).trim().split('\n').slice(-1)[0]}`);
            }
        },
    });
}
