import { readFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { expect, it } from 'vitest'
import type { Config } from '../src/index.js'
import { nativeHarness, nativeSend, nativeText } from './native-harness.js'
import { foldSurface, deriveEventMessage, SessionId } from '@deepseek-ai/dsh-session'

type Entry = { id: string, name: string, config?: Config }
function entries(path: string): Entry[] {
  // Parse !!js scalars as text; this offline gate never evaluates profile code.
  const document = parseDocument(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  expect(document.errors).toEqual([])
  expect(document.warnings).toEqual([])
  const operations = document.toJS() as { insert: Entry[] }[]
  expect(operations.every(operation => Array.isArray(operation.insert))).toBe(true)
  return operations.flatMap(operation => operation.insert)
}
it('loads the actual packed profile plus shipped bundle with the current config and seals by default', async () => {
  const combined = [...entries('../scripts/validation/packed-profile.patch.yml'), ...entries('../cordis.patch.yml')]
  const slice = combined.filter(entry => entry.name === '@dsh-external/dsh-slice-agent-loop')
  expect(slice).toHaveLength(1)
  const harness = await nativeHarness([nativeText('PACKED_FIXTURE_FIRST'), nativeText('PACKED_FIXTURE_SECOND')], { config: slice[0]!.config ?? {} })
  try {
    const handle = await harness.ctx.agents.create({ sessionId: SessionId('packed-config-offline'), agentOptions: { provider: 'native-mock', model: 'deterministic' } })
    await nativeSend(handle.agent, 'First request')
    await nativeSend(handle.agent, 'Second request')
    expect(harness.errors).toEqual([])
    const events = handle.agent.session.snapshotEvents()
    const messages = foldSurface(events).nodes.map(seq => deriveEventMessage(events[seq]!))
    expect(messages.some(message => message?.content.some(block => block.type === 'text' && block.text.startsWith('[slice tape v1') && block.text.includes('PACKED_FIXTURE_FIRST')))).toBe(true)
    await handle.dispose()
  } finally { await harness.ctx.fiber.dispose() }
})
