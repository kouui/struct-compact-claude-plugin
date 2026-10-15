import type { Register, SessionMessage } from 'claude-code'
import { extractPaths, slimToolUse, slimToolResult } from './slim'

const KEEP_TAIL = 4 // text messages (user and assistant, no tool calls or results) kept verbatim after the summary
const MAX_TRANSCRIPT = 600_000 // chars handed to the summarizer
const TIMEOUT_MS = 480_000

const SCHEMA = {
  type: 'object',
  properties: {
    original_tasks: { type: 'array', items: { type: 'string' }, description: 'What the user originally asked for, in their own terms' },
    must_read_files: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'why'] },
      // description: 'Files the agent must re-read to continue (specs, plans, notes, in-progress outputs)',
      description:
        'Files the agent must re-read to continue (specs, plans, notes, in-progress outputs). ' +
        'Never list the session transcript itself (the .jsonl file under .claude/projects).',
    },
    progress: {
      type: 'object',
      properties: { done: { type: 'array', items: { type: 'string' } }, in_progress: { type: 'array', items: { type: 'string' } }, next: { type: 'array', items: { type: 'string' } } },
      required: ['done', 'in_progress', 'next'],
    },
    cautions: { type: 'array', items: { type: 'string' }, description: 'Pitfalls, constraints, user preferences, things that failed' },
    key_decisions: {
      type: 'array',
      items: { type: 'object', properties: { decision: { type: 'string' }, reason: { type: 'string' } }, required: ['decision', 'reason'] },
    },
  },
  required: ['original_tasks', 'must_read_files', 'progress', 'cautions', 'key_decisions'],
}

const INSTRUCTION_BASE =
  'You receive, on stdin, a slimmed transcript of a long-running autonomous coding session: user/assistant text is verbatim; ' +
  'tool calls are reduced to the tool name, a short description and the file paths they read (R), wrote (W), deleted (D) or merely referenced (O); ' +
  'tool results are reduced to ok/ERR notes. Produce a structured handoff so the agent can continue seamlessly after its context is reset. ' +
  'Be concrete (file paths, identifiers, numbers). Do not invent. Prefer the latest state over history. ' +
  'You may use Read/Grep/Glob to check a file, but the transcript is usually enough. ' +
  'Describe only the session in the transcript: never mention your own environment or working directory, and keep paths and variables exactly as they appear in the transcript.'

const withFocus = (extra?: string) => (extra && extra.trim() ? `${INSTRUCTION_BASE} The user asked the summary to keep or stress: ${extra.trim()}` : INSTRUCTION_BASE)

function renderTranscript(messages: readonly SessionMessage[], cwd?: string): string {
  const lines: string[] = []
  const nameById = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'user') {
      for (const r of m.toolResults ?? []) {
        const s = slimToolResult(r.text, r.isError, 160)
        lines.push(`   ↳ ${nameById.get(r.tool_use_id) ?? 'tool'}: ${typeof s === 'string' ? s : JSON.stringify(s)}`)
      }
      if (m.text.trim()) lines.push(`\n[USER] ${m.text.trim()}`)
    } else {
      if (m.text.trim()) lines.push(`\n[ASSISTANT] ${m.text.trim()}`)
      for (const u of m.toolUses) {
        nameById.set(u.tool_use_id, u.tool)
        const s = slimToolUse(u.tool, u.input, { cwd })
        const { tool, ...rest } = s as Record<string, unknown>
        lines.push(`  • ${tool} ${JSON.stringify(rest)}`)
      }
    }
  }
  const text = lines.join('\n')
  if (text.length <= MAX_TRANSCRIPT) return text
  const head = text.slice(0, 20_000)
  return head + '\n…[middle of transcript omitted]…\n' + text.slice(text.length - (MAX_TRANSCRIPT - 20_000))
}

const bullets = (a?: string[]) => (a && a.length ? a.map((x) => `- ${x}`).join('\n') : '- (none)')

function renderSummary(s: any): string {
  // const files = (s.must_read_files ?? []).map((f: any) => `- ${f.path} — ${f.why}`).join('\n') || '- (none)'
  // drop the original session transcript if the summarizer listed it anyway
  // session transcripts live under .claude/projects; a project's own .jsonl data files stay allowed
  const isTranscript = (p: unknown) => /(^|[\\/])\.claude[\\/]projects[\\/]/i.test(String(p ?? ''))
  const files =
    (s.must_read_files ?? [])
      .filter((f: any) => !isTranscript(f?.path))
      .map((f: any) => `- ${f.path} — ${f.why}`)
      .join('\n') || '- (none)'
  const dec = (s.key_decisions ?? []).map((d: any) => `- ${d.decision} (${d.reason})`).join('\n') || '- (none)'
  return [
    'This session is being continued after the context was compacted. The handoff below was written from the session history.',
    '',
    '## Original tasks', bullets(s.original_tasks),
    '', '## Must-read files (re-read these before acting)', files,
    '', '## Progress', '### Done', bullets(s.progress?.done), '### In progress', bullets(s.progress?.in_progress), '### Next', bullets(s.progress?.next),
    '', '## Cautions', bullets(s.cautions),
    '', '## Key decisions', dec,
    '',
    'Continue the work from where it stopped. Do not ask the user for confirmation and do not recap this summary; re-read the must-read files if you need their details, then carry on with the next step.',
  ].join('\n')
}

export const register: Register = (on) => {
  // auto and manual (/compact) both go through the haiku summary; precompute/plugin pass straight through
  on('session.compact', async ($, e, next) => {
    if (e.trigger !== 'auto' && e.trigger !== 'manual') return next(e)
    try {
      const msgs = e.messages
      if (msgs.length < KEEP_TAIL + 4) return next(e)
      // the summarizer sees the whole session; the kept tail's tool activity reaches it as slim notes
      const transcript = renderTranscript(msgs, (e as any).cwd)
      const ran = await $.process.run(
        ['claude', '-p', withFocus(e.instructions), '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
          '--no-session-persistence', '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob'],
        { stdin: transcript, timeoutMs: TIMEOUT_MS },
      )
      if (ran.exitCode !== 0) throw new Error(`claude -p exited ${ran.exitCode}: ${ran.stderr.slice(0, 200)}`)
      const out = JSON.parse(ran.stdout)
      const s = out.structured_output
      if (!s || !Array.isArray(s.original_tasks)) throw new Error('no structured_output')

      // keep the last KEEP_TAIL messages that carry text, one by one; tool calls and tool results neither count nor are kept
      const tail: SessionMessage[] = msgs
        .filter((x) => x.text.trim())
        .slice(-KEEP_TAIL)
        .map((x) => ({ role: x.role, text: x.text, toolUses: [] }))
      const summary: SessionMessage = { role: 'user', text: renderSummary(s), toolUses: [] }
      $.ui.toast('struct-compact: summarized by haiku')
      return { messages: [summary, ...tail] }
    } catch (err) {
      $.ui.toast(`struct-compact failed, using default: ${String((err as Error)?.message ?? err).slice(0, 80)}`)
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}
