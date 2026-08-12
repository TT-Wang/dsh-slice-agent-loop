import { describe, expect, it, vi } from 'vitest'
import { Inbox, type AgentEventDispatch } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { InboxLedger, type InboxLedgerActivity } from '../src/inbox-ledger.js'
import { Context } from '@deepseek-ai/cordis'
import { ensureHarnessUniverse } from '../src/universe.js'

// InboxLedger reads the harness universe (single-instance Inbox); tests
// construct it directly without the lifecycle's await, so resolve it here.
await ensureHarnessUniverse(new Context())

function message(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'slice-loop-test' },
  })
}

function harness(id = 'inbox-ledger'): {
  session: Session
  ledger: InboxLedger
  wake: ReturnType<typeof vi.fn>
  setSignal(signal: AbortSignal | undefined): void
  emitted: Array<{ event: string; payload: unknown }>
} {
  const session = Session.create(SessionId(id))
  const emitted: Array<{ event: string; payload: unknown }> = []
  const dispatch = {
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }) },
  } as unknown as AgentEventDispatch
  const wake = vi.fn()
  let currentSignal: AbortSignal | undefined
  const activity: InboxLedgerActivity = {
    signal: () => currentSignal,
    wake,
  }
  return {
    session,
    ledger: new InboxLedger(session, dispatch, activity),
    wake,
    setSignal: signal => { currentSignal = signal },
    emitted,
  }
}

describe('InboxLedger', () => {
  it('routes followup, steer, and inject with durable-before-wake sequencing', () => {
    const { ledger, session, wake } = harness('route')
    const order: string[] = []
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((...args: Parameters<Session['append']>) => {
      order.push('append')
      return Reflect.apply(append, session, args)
    }) as Session['append'])
    wake.mockImplementation(() => { order.push('wake') })
    const followup = message('followup')
    const steer = message('steer')
    const injected = message('injected')

    ledger.followup(followup)
    ledger.steer(steer)
    ledger.inject(injected)

    expect(ledger.inbox.nextTurn).toEqual([followup])
    expect(ledger.inbox.nextStep).toEqual([steer, injected])
    expect(order).toEqual(['append', 'wake', 'append', 'wake', 'append'])
  })

  it('reroutes only waking input submitted after active cancellation', () => {
    const { ledger, setSignal, wake } = harness('abort-route')
    const abort = new AbortController()
    abort.abort({ kind: 'user' })
    setSignal(abort.signal)
    const steer = message('steer after abort')
    const injected = message('inject after abort')

    ledger.steer(steer)
    ledger.inject(injected)

    expect(ledger.inbox.nextTurn).toEqual([steer])
    expect(ledger.inbox.nextStep).toEqual([injected])
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('claims all next-step messages before exactly one next-turn message', () => {
    const { ledger, session, emitted } = harness('claim')
    const context = message('context')
    const first = message('first')
    const second = message('second')
    ledger.inject(context)
    ledger.followup(first)
    ledger.followup(second)
    const beforeClaim = session.events.length

    expect(ledger.claimFirstStep(3)).toEqual([context, first])

    expect(ledger.inbox.nextStep).toEqual([])
    expect(ledger.inbox.nextTurn).toEqual([second])
    expect(session.events.slice(beforeClaim).map(event => {
      if (event.type !== 'agent/inbox/spliced') return event.type
      return event.data
    })).toEqual([
      { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
      { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    ])
    expect(emitted.filter(entry => entry.event === 'agent/inbox/claimed')).toEqual([
      { event: 'agent/inbox/claimed', payload: { message: context, turn: 3 } },
      { event: 'agent/inbox/claimed', payload: { message: first, turn: 3 } },
    ])

    // A rejected pre-step performs no ledger action: claimed input stays gone.
    expect(ledger.claimNextStep(3)).toEqual([])
    expect(ledger.inbox.nextTurn).toEqual([second])
  })

  it('replays durable splices and preserves cross-list identity uniqueness', () => {
    const session = Session.create(SessionId('replay'))
    const pending = message('persisted')
    session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [pending],
    })
    const dispatch = { emit: vi.fn() } as unknown as AgentEventDispatch
    const activity: InboxLedgerActivity = { signal: () => undefined, wake: vi.fn() }

    const ledger = new InboxLedger(session, dispatch, activity)

    expect(ledger.inbox.nextTurn).toEqual([pending])
    expect(() => { ledger.inject(pending) })
      .toThrow(`message "${pending.id}" is already pending`)
    expect(activity.wake).not.toHaveBeenCalled()
  })

  it('commits a splice before mutating the live projection', () => {
    const { ledger, session } = harness('append-before-projection')
    const pending = message('pending')
    const seen: UserMessage[][] = []
    const append = session.append.bind(session)
    vi.spyOn(session, 'append').mockImplementation(((...args: Parameters<Session['append']>) => {
      if (args[0] === 'agent/inbox/spliced') seen.push([...ledger.inbox.nextTurn])
      return Reflect.apply(append, session, args)
    }) as Session['append'])

    ledger.followup(pending)

    expect(seen).toEqual([[]])
    expect(ledger.inbox.nextTurn).toEqual([pending])
  })

  it('clears only pending input as durable cancellations', () => {
    const { ledger, session } = harness('clear')
    const claimed = message('claimed')
    const pending = message('pending')
    ledger.followup(claimed)
    ledger.followup(pending)
    ledger.claimFirstStep(1)
    const beforeClear = session.events.length

    ledger.clear()

    expect(ledger.hasPending).toBe(false)
    expect(session.events.slice(beforeClear).map(event => event.type === 'agent/inbox/spliced'
      ? event.data
      : event.type)).toEqual([
      { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    ])
  })

  it('exposes the exact public dsh Inbox required by Agent', () => {
    const { ledger } = harness('public-inbox')
    expect(ledger.inbox).toBeInstanceOf(Inbox)
  })
})

