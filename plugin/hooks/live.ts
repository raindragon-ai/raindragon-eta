// Live status line for RainDragon ETA: a running clock next to the band, e.g.
//   ⏱ 0:42 · half took 40s–3m
// in Claude Code's status line while a turn runs; cleared when it ends.
//
// Nothing is estimated here. The UserPromptSubmit hook (scripts/raindragon_eta_hook.py)
// has already worked out the band before `turn.start` fires and saved it in
// <data dir>/pending/<session>; this module only reads that file and ticks.
// A mod is told its plugin's root but not its data dir, so the hook leaves the
// data dir's path at ~/.raindragon-eta/data_dir.
//
// Clients without mods ignore this file and still get the hook's one-line
// message when the prompt is sent.
import type { Register } from 'claude-code'

export type Pending = {
  start: number            // epoch seconds, from the hook
  low: number | null       // band, seconds; null while learning
  high: number | null
  cov?: string             // "50" | "80"
  learning?: boolean | null
  typical?: boolean | null // band from the built-in table, not the user's turns
  learned?: number         // good turns so far
  incident?: boolean
}

const MIN_READY = 10       // keep in step with raindragon_eta/predict.py

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// Same rounding as raindragon_eta/fmt.py duration().
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60
    if (m < 10 && r >= 30) return `${m}m30s`
    return `${m + (r >= 30 && m >= 10 ? 1 : 0)}m`
  }
  let h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  if (m === 60) { h += 1; m = 0 }
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}m`
}

export function line(p: Pending, elapsedMs: number): string {
  const parts = [`⏱ ${clock(elapsedMs)}`]
  if (p.low != null && p.high != null) {
    const share = p.cov === '80' ? '8 in 10' : 'half'
    const lo = duration(p.low), hi = duration(p.high)
    parts.push(`${share} took ${lo === hi ? lo : `${lo}–${hi}`}${p.typical ? ' (typical)' : p.learning ? ' (learning)' : ''}`)
    if (elapsedMs / 1000 > p.high) parts.push('longer than usual')
  } else {
    parts.push(`learning your pace (${p.learned ?? 0}/${MIN_READY})`)
  }
  if (p.incident) parts.push('Claude incident')
  return parts.join(' · ')
}

export function safeSession(id: string): string {
  return (id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
}

export const register: Register = on => {
  let tick: { cancel: () => void } | undefined
  // Bumped whenever a turn starts or ends. A tick checks it after its await,
  // so one already in flight when the turn ends cannot redraw a stale clock.
  let turn = 0

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    try {
      tick?.cancel()
      tick = undefined
      const mine = ++turn
      const home = await $.env.get('HOME')
      if (!home) return result
      const dir = (await $.fs.read(`${home}/.raindragon-eta/data_dir`)).trim()
      const sid = safeSession(await $.session.id())
      const p = JSON.parse(await $.fs.read(`${dir}/pending/${sid}`)) as Pending
      if (typeof p.start !== 'number') return result
      const startMs = p.start * 1000
      const show = async () => {
        const now = await $.clock.now()
        if (mine === turn) $.ui.status(line(p, now - startMs))
      }
      if (mine !== turn) return result
      await show()
      if (mine === turn) tick = $.clock.every(1000, () => { void show() })
    } catch {
      // No pending turn (plugin off, file missing): show nothing.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turn += 1
      tick?.cancel()
      tick = undefined
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    turn += 1
    tick?.cancel()
    tick = undefined
    $.ui.status(undefined)
    return next(e)
  })
}
