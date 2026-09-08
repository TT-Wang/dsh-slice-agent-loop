/** Compatibility import: use the stock loop's full request reconstruction check.
 * Mount either this path or @deepseek-ai/dsh-agent-loop/invariant, never both.
 */
export { name, inject, apply } from '@deepseek-ai/dsh-agent-loop/invariant';
