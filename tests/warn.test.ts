import { test, expect, mock } from 'claude-code/testing'

import { effectiveThreshold, isNearCompaction, isRearmed, reminderText } from '../hooks/warn'

test('isNearCompaction compares the distance to the compaction point with the margin', async () => {
  // window 500k, compaction at 467k, margin 8% = 40k
  expect(isNearCompaction(400_000, 467_000, 500_000, 8)).toBe(false)
  expect(isNearCompaction(430_000, 467_000, 500_000, 8)).toBe(true)
  expect(isNearCompaction(467_000, 467_000, 500_000, 8)).toBe(true)
  expect(isNearCompaction(10, 0, 500_000, 8)).toBe(false) // no known threshold
})

test('isRearmed needs the context to fall well back', async () => {
  expect(isRearmed(430_000, 467_000, 500_000, 8)).toBe(false)
  expect(isRearmed(380_000, 467_000, 500_000, 8)).toBe(true) // 87k left, more than 2 x 40k
})

test('reminderText names the distance and the notes file', async () => {
  const t = reminderText(430_000, 467_000, './tmp/context-notes.md')
  expect(t).toContain('about 37k tokens')
  expect(t).toContain('./tmp/context-notes.md')
})

test('a tool result gets the reminder once, near the compaction point', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 440_000,
        window: 1_000_000,
        percent: 44,
        breakdown: { rawMaxTokens: 500_000, autoCompactThreshold: 467_000, categories: [] },
      },
      rateLimits: [],
    },
  }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))

  const first = (await $.tool.call({ tool: 'Bash', input: { command: 'ls' } })) as { context?: string[] }
  expect(first.context?.join(' ')).toContain('tokens from automatic compaction')

  const second = (await $.tool.call({ tool: 'Bash', input: { command: 'ls' } })) as { context?: string[] }
  expect(second.context).toBeUndefined()
})

test('effectiveThreshold lowers the compaction point by CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', async () => {
  expect(effectiveThreshold(467_000, undefined)).toBe(467_000)
  expect(effectiveThreshold(467_000, '90')).toBe(432_000) // 90% of the 480k window less nothing else
  expect(effectiveThreshold(467_000, '100')).toBe(467_000)
  expect(effectiveThreshold(467_000, 'abc')).toBe(467_000)
  expect(effectiveThreshold(467_000, '99')).toBe(467_000) // 475,200 is above the engine's own point
})
