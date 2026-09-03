/**
 * bench-tools — 评测用的两个"一次给一整份"的工具(2026-09-04):
 *   fetch_page(url)  从工作目录 site/ 里取整页文本(离线、确定性;HTML 去标签),形状同网页抓取工具;
 *   db_query(sql)    对工作目录 data/*.db(SQLite)执行 SQL,整份结果按 JSONL 返回(每行一个对象),形状同数据库/MCP 查询工具。
 * 两者都接不了 `| grep`——这是折叠真正起作用的工具形状;shell 输出模型会自己过滤。
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare function fetchPageTool(workdir: string): ToolDefinition;
export declare function dbQueryTool(workdir: string): ToolDefinition;
