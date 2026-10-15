// @ts-nocheck
// slim.mjs (v1) — rule-based slimming of tool calls/results. Pure functions, no Node APIs,
// so it can be pasted into a mod hooks module as-is.
// Path classes: R read, W write, 'W?' python-write (uncertain), D delete, O referenced-only (git add, cd), T unknown.

const EXT =
  'py|ts|tsx|js|mjs|cjs|jsx|json|jsonl|md|mdx|txt|csv|tsv|yaml|yml|toml|ini|cfg|conf|sh|ps1|bat|cmd|sql|html|css|scss|' +
  'cs|csproj|sln|unity|prefab|asset|meta|shader|cpp|hpp|c|h|go|rs|java|kt|swift|rb|php|lua|xml|svg|png|jpg|jpeg|gif|webp|pdf|zip|log|lock|env|exe'

const SEG = String.raw`[\p{L}\p{N}_.\-@+$\{\}~*?]`
const TAIL = String.raw`[^\s"'<>|;,()\x60]`
const RE_PATH = new RegExp(
  [
    String.raw`(["'])(?:[A-Za-z]:[\\/]|\/[a-zA-Z]\/)[^"'\n]*\1`, // quoted drive path, may contain spaces
    String.raw`[A-Za-z]:[\\/]${TAIL}+`, // D:\x or D:/x
    String.raw`(?<![\w.])\/[a-zA-Z]\/${TAIL}+`, // /d/x (git-bash drive)
    String.raw`\$(?:env:)?[A-Za-z_]\w*(?:[\\/]${SEG}+)+`, // $TEMP/x, $env:TEMP\x
    String.raw`(?<![\w.:\-])\/(?:[\w.\-@+*]+\/)+[\w.\-@+*]*`, // /abs/path
    String.raw`(?<![\w.\-/\\:$])(?:\.{1,2}[\\/])?${SEG}+(?:[\\/]${SEG}+)+`, // rel/path
    String.raw`(?<![\p{L}\p{N}_.\-/\\$])[\p{L}\p{N}_\-]{2,}(?:\.[\p{L}\p{N}_\-]+)*\.(?:${EXT})\b`, // bare file.ext
  ].join('|'),
  'gu',
)
const IGNORE = /^(\/dev\/(null|stdout|stderr|stdin)|\/proc\/|https?:)/i
const PRI = { D: 6, W: 5, 'W?': 4, R: 3, O: 2, T: 1 }

const strip = (s) => {
  const t = s.trim()
  return t.length > 1 && /^["']/.test(t) && t[0] === t[t.length - 1] ? t.slice(1, -1) : t
}
const norm = (p, cwdN) => {
  let s = strip(p).replace(/\\+/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/').replace(/[.,:;)\]}'"`]+$/, '').replace(/^\.\//, '').replace(/\/$/, '')
  if (cwdN) {
    const l = s.toLowerCase()
    if (l === cwdN) return ''
    if (l.startsWith(cwdN + '/')) s = s.slice(cwdN.length + 1)
  }
  return s
}

// heredoc bodies are split off: code bodies (python/node/bash...) are scanned, prose bodies (cat >> f <<EOF) are ignored
function splitHeredocs(cmd) {
  const bodies = []
  const re = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(cmd))) {
    const start = m.index + m[0].length
    const lineStart = cmd.lastIndexOf('\n', m.index) + 1
    const consumer = cmd.slice(lineStart, m.index)
    const endRe = new RegExp('^\\s*' + m[2] + '\\s*$', 'm')
    const rest = cmd.slice(start)
    const e = endRe.exec(rest)
    bodies.push({ text: e ? rest.slice(0, e.index) : rest, code: /\b(python3?|py|node|bash|sh|pwsh|powershell|ruby|perl)\b/i.test(consumer) })
    out += cmd.slice(last, start) + '\n'
    last = e ? start + e.index + e[0].length : cmd.length
    re.lastIndex = last
  }
  return { main: out + cmd.slice(last), bodies }
}


// `for x in a b c; do BODY; done` with a literal word list: repeat BODY once per item (innermost loops first)
function expandLoops(text) {
  const re = /\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n$`*?(){}]+?)\s*(?:;|\n)\s*do\b((?:(?!\bfor\s+\w+\s+in\b)[\s\S])*?)(?:;|\n)\s*done\b/
  for (let guard = 0; guard < 8; guard++) {
    const m = re.exec(text)
    if (!m) break
    const items = m[2].trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, '')).slice(0, 30)
    const v = m[1]
    const body = items.map((it) => m[3].replace(new RegExp('\\$\\{?' + v + '\\}?(?![\\w])', 'g'), () => it)).join(';\n')
    text = text.slice(0, m.index) + body + text.slice(m.index + m[0].length)
  }
  return text
}

function splitStatements(cmd) {
  const out = []
  let cur = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      cur += ch
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue }
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue }
    if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) {
      if (ch === '&' || (ch === '|' && cmd[i + 1] === '|')) i++
      out.push(cur); cur = ''; continue
    }
    cur += ch
  }
  out.push(cur)
  return out.filter((s) => s.trim())
}

const READ_CMDS = new Set('cat type head tail grep egrep fgrep rg awk wc ls dir ll less more diff find file stat sort uniq cut nl get-content gc select-string sls get-childitem gci test-path cygpath realpath readlink sha256sum md5sum od xxd tree du python python3 py uv node dotnet bash sh pwsh powershell make cargo npm yarn go source .'.split(' '))
const WRITE_CMDS = new Set('tee touch mkdir md set-content add-content out-file new-item ni tee-object install'.split(' '))
const DEL_CMDS = new Set('rm rmdir del erase remove-item ri unlink'.split(' '))
const COPY_CMDS = new Set('cp copy copy-item xcopy'.split(' '))
const MOVE_CMDS = new Set('mv move move-item rename-item ren'.split(' '))
const PYISH = new Set('python python3 py node'.split(' '))
const PATTERN_CMDS = new Set('grep egrep fgrep rg awk sed select-string sls'.split(' '))
const PROSE_CMDS = new Set('echo printf write-host write-output'.split(' '))
const PY_WRITE = /write_text|write_bytes|open\([^)]*['"][wax]\+?b?t?['"]|json\.dump\(|\.to_csv|\.to_json|savefig|shutil\.(copy\w*|move|rmtree)|os\.(remove|rename|replace|makedirs)|\.save\(/
const PY_READ = /read_text|read_bytes|json\.load\(|read_csv|open\(/

const POSITIONAL_PATTERN_CMDS = new Set('grep egrep fgrep rg sed awk'.split(' '))
const CONTENT_ARG_CMDS = new Set('add-content set-content out-file'.split(' '))
const BARE_VERBS = new Set('mkdir md rmdir rm touch ls dir cat head tail wc stat cp mv cd'.split(' '))
const tokens = (text) => { const out = []; const re = /"[^"]*"|'[^']*'|\S+/g; let m; while ((m = re.exec(text))) out.push({ s: m[0], i: m.index }); return out }
const tokName = (s) => s.replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '')
// grep/sed/awk: the first positional operand is the pattern or script, not a file
function blankPattern(text, name) {
  const toks = tokens(text)
  const k = toks.findIndex((t) => tokName(t.s) === name)
  if (k < 0) return text
  const VALUE_FLAGS = new Set(['-m', '-A', '-B', '-C', '-d', '-v', '-F', '--max-count'])
  for (let j = k + 1; j < toks.length; j++) {
    const t = toks[j].s
    if (/^\d*>>?$/.test(t)) { j++; continue }
    if (t.startsWith('-')) { if (VALUE_FLAGS.has(t)) j++; else if (t === '-e') { return blankAt(text, toks[j + 1]) } continue }
    return blankAt(text, toks[j])
  }
  return text
}
const blankAt = (text, tok) => (tok ? text.slice(0, tok.i) + '""' + text.slice(tok.i + tok.s.length) : text)

function headOf(stmt) {
  let s = stmt.trim()
  let prev
  do {
    prev = s
    s = s.replace(/^\$\(\s*/, '').replace(/^(?:do|then|else|elif|if|while|until|!|\{|\(|&)\s+/, '').replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')
  } while (s !== prev)
  const toks = s.split(/\s+/)
  const name = (toks[0] ?? '').replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '')
  let sub = ''
  if (name === 'git') {
    for (let i = 1; i < toks.length; i++) {
      if (toks[i] === '-C' || toks[i] === '-c') { i++; continue }
      if (toks[i].startsWith('-')) continue
      sub = toks[i].toLowerCase(); break
    }
  }
  return { name, sub, rest: s }
}

function quoteSpanAt(stmt, idx) {
  let q = null, start = -1
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i]
    if (q) { if (ch === q) { if (idx > start && idx < i) return [start, i]; q = null } continue }
    if (ch === '"' || ch === "'") { q = ch; start = i }
  }
  return null
}

function plausible(p, stmt, idx, raw) {
  if (p.length < 3 || !/\w/.test(p) || IGNORE.test(p) || /\.exe$/i.test(p)) return false
  if (/(^|\/)\.?venv\/(?:bin|Scripts)\/[\w.\-]+$|(^|\/)bin\/python[\d.]*$|^mozilla\/|:\/\/|^\$\w+\/\w$/i.test(p)) return false
  const segs = p.split('/')
  if (segs.some((s) => s.includes('..') && s !== '..')) return false
  if (/^[A-Za-z]:/.test(p) || p.startsWith('$') || p.startsWith('/')) return true
  if (/\.[A-Za-z0-9*]{1,6}$/.test(segs[segs.length - 1])) return true
  if (segs.every((s) => /^\d+[a-z]?$/i.test(s) || s.length <= 2)) return false
  if (segs.length >= 3) return true
  // two segments, no extension: only accept a whole token that is not inside prose
  const before = stmt[idx - 1], after = stmt[idx + raw.length]
  if ((before !== undefined && !/[\s"'=(]/.test(before)) || (after !== undefined && !/[\s"')/]/.test(after))) return false
  const span = quoteSpanAt(stmt, idx)
  if (span && stmt.slice(span[0] + 1, span[1]).trim() !== raw.trim()) return false
  return true
}

export function extractPaths(command, { cwd, maxPerClass = 12 } = {}) {
  const cwdN = cwd ? cwd.replace(/\\+/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/').replace(/\/$/, '').toLowerCase() : null
  const best = new Map()
  const put = (p, cls) => { if (p && (!best.has(p) || PRI[cls] > PRI[best.get(p)])) best.set(p, cls) }
  const vars = new Map()
  let curDir = '' // cwd-relative (or absolute) directory after `cd`
  const joinDir = (dir, p) => {
    const out = []
    for (const sgm of (dir ? dir + '/' + p : p).split('/')) {
      if (sgm === '..') { if (out.length && out[out.length - 1] !== '..' && out[0] !== '') out.pop(); else out.push('..') } else if (sgm && sgm !== '.') out.push(sgm)
    }
    return out.join('/')
  }
  const isAbs = (p) => /^([A-Za-z]:|\/|\$)/.test(p)
  const relocate = (p) => (curDir && !isAbs(p) ? joinDir(curDir, p) : p)

  const matchesIn = (stmt, codeLike) => {
    const text = codeLike ? stmt.replace(/\\[ntr]/g, ' ') : stmt
    const found = []
    RE_PATH.lastIndex = 0
    let m
    while ((m = RE_PATH.exec(text))) {
      let raw = m[0]
      let p = norm(raw, cwdN).replace(/^\$\{?(?:PWD|SUB)\}?\//, '') // $PWD/x and $(pwd -W)/x are relative to cwd
      const left = text.slice(0, m.index)
      if (!p || !plausible(p, text, m.index, raw)) continue
      found.push({ p, idx: m.index, left })
    }
    return { text, found }
  }

  const classify = (head, text, f, i, n, found) => {
    if (/(?<![-=])>{1,2}\|?\s*["']?$/.test(f.left)) return 'W'
    if (/\s-C\s+["']?$/.test(f.left)) return 'R'
    const { name, sub } = head
    if (['cd', 'pushd', 'set-location', 'sl'].includes(name)) return 'O'
    if (name === 'git') {
      if (['add', 'commit', 'stash', 'branch', 'tag', 'fetch', 'push', 'pull', 'merge', 'rebase', 'reset', 'cherry-pick', 'worktree', 'switch', 'config'].includes(sub)) return 'O'
      if (['restore', 'checkout', 'apply', 'mv'].includes(sub)) return 'W'
      if (sub === 'rm') return 'D'
      return 'R'
    }
    if (name === 'sed') return /\s-i/.test(text) ? 'W' : 'R'
    if (name === 'robocopy') return i === 0 ? 'R' : /\/(MIR|PURGE)\b/i.test(text) ? 'D' : 'W'
    if (COPY_CMDS.has(name)) return i === n - 1 ? 'W' : 'R'
    if (MOVE_CMDS.has(name)) return 'W'
    if (DEL_CMDS.has(name)) return 'D'
    if (WRITE_CMDS.has(name)) return 'W'
    if (PYISH.has(name) && PY_WRITE.test(text)) return 'W?'
    if (READ_CMDS.has(name)) return 'R'
    return PY_WRITE.test(text) ? 'W?' : 'T'
  }

  const scanShell = (stmt0) => {
    let stmt = stmt0
    // plain assignment: remember whole-path variables, substitute them later
    const asg = /^\s*(?:export\s+|local\s+)?\$?([A-Za-z_]\w*)\s*=\s*(.+)$/s.exec(stmt)
    if (asg && !/^\s*[[(]/.test(asg[2])) {
      const val = strip(asg[2])
      const { found } = matchesIn(val, false)
      if (found.length === 1 && norm(val, cwdN) === found[0].p) { vars.set(asg[1], strip(val)); put(found[0].p, 'T'); return }
    }
    // command substitutions $( ... ) are scanned as statements of their own
    for (let guard = 0; guard < 6; guard++) {
      const sm = /\$\(((?:[^()]|\([^()]*\))*)\)/.exec(stmt)
      if (!sm) break
      scanShell(sm[1])
      stmt = stmt.slice(0, sm.index) + '$SUB' + stmt.slice(sm.index + sm[0].length)
    }
    for (const [name, val] of vars) stmt = stmt.replace(new RegExp('\\$\\{?' + name + '\\}?(?![\\w])', 'g'), () => val)
    const head = headOf(stmt)
    let text = stmt
    if (PROSE_CMDS.has(head.name)) text = text.replace(/"[^"]*"|'[^']*'/g, '""')
    else if (CONTENT_ARG_CMDS.has(head.name)) text = text.replace(/"[^"]*\s[^"]*"|'[^']*\s[^']*'/g, '""') // quoted text content, not a path
    else if (POSITIONAL_PATTERN_CMDS.has(head.name)) text = blankPattern(text, head.name)
    else if (head.name === 'select-string' || head.name === 'sls') text = text.replace(/(?<!>\s*)(?:"[^"]*"|'[^']*')/, '""')
    const { text: t2, found } = matchesIn(text, PYISH.has(head.name) || /\bpython3?\b/.test(text))
    if (BARE_VERBS.has(head.name)) {
      // single-word file/dir operands (mkdir -p tmp, rm build) have no slash or extension to recognise them by
      const toks = tokens(t2)
      const k = toks.findIndex((t) => tokName(t.s) === head.name)
      for (let j = k + 1; k >= 0 && j < toks.length; j++) {
        const t = strip(toks[j].s)
        if (/^\d*>>?/.test(t)) { j++; continue }
        if (!/^[A-Za-z_][\w.\-]*$/.test(t) || found.some((f) => f.p === t)) continue
        found.push({ p: t, idx: toks[j].i, left: '' })
      }
    }
    const isCd = ['cd', 'pushd', 'set-location', 'sl'].includes(head.name)
    found.forEach((f, i) => put(isCd ? f.p : relocate(f.p), classify(head, t2, f, i, found.length, found)))
    if (isCd) {
      const tk = tokens(t2).slice(1).map((t) => strip(t.s)).filter((t) => !t.startsWith('-') && !/^\d*>/.test(t))[0]
      if (tk && !/\$/.test(tk)) {
        const n = norm(tk, cwdN)
        if (n === '' || n === '.') curDir = ''
        else if (isAbs(n)) curDir = n
        else curDir = joinDir(curDir, n)
      }
    }
  }

  const { main, bodies } = splitHeredocs(command.replace(/https?:\/\/\S+/g, ' '))
  for (const stmt of splitStatements(expandLoops(main))) scanShell(stmt)
  for (const b of bodies) {
    if (!b.code) continue
    const cls = PY_WRITE.test(b.text) ? 'W?' : PY_READ.test(b.text) ? 'R' : 'T'
    for (const f of matchesIn(b.text, true).found) put(f.p, cls)
  }

  const out = {}
  for (const [p, cls] of best) (out[cls] ??= []).push(p)
  for (const k of Object.keys(out)) if (out[k].length > maxPerClass) out[k] = [...out[k].slice(0, maxPerClass), `+${out[k].length - maxPerClass} more`]
  return out
}

const squash = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + `…(+${t.length - n})` : t
}

export function slimToolUse(tool, input = {}, opts = {}) {
  const head = opts.headChars ?? 160
  const cwdN = opts.cwd ? opts.cwd.replace(/\\+/g, '/').replace(/\/$/, '').toLowerCase() : null
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = String(input.command ?? '')
      return { tool, desc: input.description, cmd_head: squash(cmd, head), n_chars: cmd.length, paths: extractPaths(cmd, opts) }
    }
    case 'Read':
      return { tool, paths: { R: [norm(String(input.file_path ?? ''), cwdN)] } }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { tool, paths: { W: [norm(String(input.file_path ?? input.notebook_path ?? ''), cwdN)] } }
    case 'Agent':
    case 'Task': {
      const prompt = String(input.prompt ?? '')
      return { tool, desc: input.description, model: input.model, prompt_head: squash(prompt, head), paths: extractPaths(prompt, opts) }
    }
    case 'Grep':
    case 'Glob':
      return { tool, pattern: squash(input.pattern, 80), path: input.path && norm(String(input.path), cwdN) }
    case 'WebFetch':
    case 'WebSearch':
      return { tool, target: squash(input.url ?? input.query, 120) }
    default:
      return { tool, input_head: squash(JSON.stringify(input), head) }
  }
}

export function slimToolResult(text, isError, errChars = 200) {
  const t = String(text ?? '')
  return isError ? `ERR ${squash(t, errChars)} (${t.length} chars)` : `ok ${t.length} chars`
}
