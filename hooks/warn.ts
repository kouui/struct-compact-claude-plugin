// Pure helpers for the "context is about to be compacted" reminder. No engine access: unit-tested directly.

/** Tokens a count is written as: `950`, `48k`. */
function k(n: number): string {
  return n < 1000 ? String(Math.round(n)) : `${Math.round(n / 1000)}k`
}

/**
 * Whether the reminder is due: the context is within `marginPercent` of the compaction window
 * from the point where auto-compaction runs. `tokens` is the last request's input size,
 * `threshold` the size at which compaction runs, `window` the compaction window.
 */
export function isNearCompaction(tokens: number, threshold: number, window: number, marginPercent: number): boolean {
  if (!(tokens >= 0) || !(threshold > 0) || !(window > 0)) return false
  return threshold - tokens <= (window * marginPercent) / 100
}

/** Whether the context has fallen far enough back (compaction ran, or /clear) for the reminder to be armed again. */
export function isRearmed(tokens: number, threshold: number, window: number, marginPercent: number): boolean {
  return threshold - tokens > (window * marginPercent * 2) / 100
}

/** The reminder the model reads after a tool result. */
export function reminderText(tokens: number, threshold: number, notesFile: string): string {
  const left = Math.max(0, threshold - tokens)
  return (
    `Context is about ${k(left)} tokens from automatic compaction. ` +
    'Before it happens, write anything valuable that is not on disk yet ' +
    '(decisions and their reasons, findings from files you read or commands you ran, open questions, next steps) ' +
    `to one notes file (for example ${notesFile}), then continue the current task. ` +
    'Do not stop to ask. Keep the note short; the compaction summary lists files you wrote.'
  )
}
