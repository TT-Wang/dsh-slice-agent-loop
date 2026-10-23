/**
 * The model-facing text of the host's file tools, and in-memory stand-ins for them.
 *
 * The formats copy DSH 0.2.1-rc.2 `@deepseek-ai/dsh-tool-fs` (read-render.ts
 * formatReadOutput, edit.ts formatEditOutput, write.ts formatWriteOutput), which
 * does not export them. The working-set policy reads these texts: a full view is
 * a `read` that starts at line 1 and ends with the end-of-file footer.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

export function readText(path: string, lines: readonly string[], from = 1, total = from + lines.length - 1): string {
  const end = from + lines.length - 1
  const footer = end < total ? `(Showing lines ${from}-${end} of ${total}. Use offset=${end + 1} to continue.)` : `(End of file - total ${total} lines)`
  const body = lines.length ? `${lines.map((line, index) => `${from + index}: ${line}`).join('\n')}\n\n${footer}` : footer
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

export const editText = (path: string): string => `The file ${path} has been updated successfully.`

export const writeText = (path: string, created = true): string => `<path>${path}</path>\n<type>file</type>\n<content>\n${created ? 'Created' : 'Updated'} file\n</content>`

/** `read`, `edit`, `write` and an inert `bash` over a map of absolute paths to contents. */
export function registerFsFixtures(ctx: Context, files: Map<string, string>): void {
  const lines = (path: string): string[] => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`FS_NOT_FOUND: ${path}`)
    return content === '' ? [] : content.replace(/\n$/, '').split('\n')
  }
  ctx.tools.register(defineContentToolFixture({
    name: 'read', description: 'Read a file', parameters: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
    execute: async (args: unknown) => {
      const { file_path: path, offset = 1, limit = 2_000 } = args as { file_path: string; offset?: number; limit?: number }
      const all = lines(path)
      return [{ type: 'text', text: readText(path, all.slice(offset - 1, offset - 1 + limit), offset, all.length) }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'edit', description: 'Edit a file', parameters: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    execute: async (args: unknown) => {
      const { file_path: path, old_string: before, new_string: after } = args as { file_path: string; old_string: string; new_string: string }
      const content = files.get(path)
      if (content === undefined || !content.includes(before)) throw new Error(`old_string not found in ${path}`)
      files.set(path, content.replace(before, after))
      return [{ type: 'text', text: editText(path) }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'write', description: 'Write a file', parameters: { file_path: { type: 'string' }, content: { type: 'string' } },
    execute: async (args: unknown) => {
      const { file_path: path, content } = args as { file_path: string; content: string }
      const created = !files.has(path)
      files.set(path, content)
      return [{ type: 'text', text: writeText(path, created) }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'bash', description: 'Run a command (inert fixture)', parameters: { command: { type: 'string' } },
    execute: async () => [{ type: 'text', text: 'COMMAND_OUTPUT ok' }],
  }))
}
