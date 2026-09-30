import type { RGBA } from "@opentui/core"
import type { ClaimRecord, SessionNode } from "../shared/types.ts"
import type { SubtreeRollup } from "../hub/tree.ts"
import { SESSION_STATUS, STATUS_GROUPS, type StatusGroup } from "./command-center.ts"

export type Skin = {
  panel: RGBA | string
  border: RGBA | string
  text: RGBA | string
  muted: RGBA | string
  accent: RGBA | string
  error: RGBA | string
  warning: RGBA | string
  success: RGBA | string
  selection: RGBA | string
  secondary: RGBA | string
}

export type ThemeLike = {
  text: {
    base: RGBA | string
    muted: RGBA | string
    action: { primary: { base: RGBA | string }; secondary: { base: RGBA | string } }
    feedback: Record<"error" | "warning" | "success" | "info", { base: RGBA | string }>
  }
  background: { base: RGBA | string; raised: { base: RGBA | string } }
  border: { base: RGBA | string }
}

/** Maps the v2 resolved theme tokens onto the dashboard skin. */
export function skinForTheme(theme: ThemeLike): Skin {
  return {
    panel: theme.background.base,
    border: theme.border.base,
    text: theme.text.base,
    muted: theme.text.muted,
    accent: theme.text.action.primary.base,
    error: theme.text.feedback.error.base,
    warning: theme.text.feedback.warning.base,
    success: theme.text.feedback.success.base,
    selection: theme.background.raised.base,
    secondary: theme.text.action.secondary.base,
  }
}

export function age(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function statusMark(status: SessionNode["status"]): string {
  return SESSION_STATUS[status].mark
}

export function statusColor(skin: Skin, status: SessionNode["status"]): RGBA | string {
  return skin[SESSION_STATUS[status].color]
}

export function sessionLabel(session: SessionNode): string {
  const name = session.title?.trim() || session.sessionID.slice(0, 12)
  return name.length > 42 ? `${name.slice(0, 41)}…` : name
}

export function claimLabel(claim: ClaimRecord, now: number): string {
  const expiry = Date.parse(claim.expires)
  const remaining = Number.isNaN(expiry) ? "?" : age(now, expiry)
  const baton = claim.scopes.baton ? ` ⚑${claim.scopes.baton}` : ""
  return `${claim.agent} ${remaining}${baton}`
}

export function shortID(sessionID: string): string {
  return sessionID.slice(0, 8)
}

export function rollupLabel(rollup: SubtreeRollup): string | undefined {
  const parts: string[] = []
  if (rollup.total > 1) parts.push(`${rollup.total - 1} sub`)
  if (rollup.busy) parts.push(`${rollup.busy} busy`)
  if (rollup.retry) parts.push(`${rollup.retry} retry`)
  if (rollup.error) parts.push(`${rollup.error} err`)
  if (rollup.deleted) parts.push(`${rollup.deleted} deleted`)
  if (rollup.cost) parts.push(`$${rollup.cost.toFixed(4)}`)
  return parts.length ? parts.join(" · ") : undefined
}

export function rollupDetail(rollup: SubtreeRollup): string {
  const parts = [`${rollup.total} session${rollup.total === 1 ? "" : "s"}`]
  if (rollup.busy) parts.push(`${rollup.busy} busy`)
  if (rollup.retry) parts.push(`${rollup.retry} retry`)
  if (rollup.error) parts.push(`${rollup.error} err`)
  if (rollup.deleted) parts.push(`${rollup.deleted} deleted`)
  if (rollup.cost) parts.push(`$${rollup.cost.toFixed(4)}`)
  return parts.join(" · ")
}

export function groupMark(group: StatusGroup, status: SessionNode["status"]): string {
  return group === "needs" && status === "error" ? "!" : STATUS_GROUPS[group].mark
}

export function groupColor(skin: Skin, group: StatusGroup): RGBA | string {
  return skin[STATUS_GROUPS[group].color]
}

export type MarqueeTarget = {
  readonly width: number
  readonly scrollWidth: number
  scrollX: number
}

export type MarqueeStep = {
  offset: number
  direction: 1 | -1
}

export function marqueeStep(offset: number, max: number, direction: 1 | -1): MarqueeStep {
  if (max <= 0) return { offset: 0, direction: 1 }
  let next = offset + direction
  let nextDirection = direction
  if (next >= max) {
    next = max
    nextDirection = -1
  } else if (next <= 0) {
    next = 0
    nextDirection = 1
  }
  return { offset: next, direction: nextDirection }
}

export type Marquee = {
  start: () => void
  stop: () => void
  readonly active: boolean
}

export function createMarquee(
  getTarget: () => MarqueeTarget | undefined,
  options: { intervalMs?: number } = {},
): Marquee {
  const intervalMs = options.intervalMs ?? 120
  let timer: ReturnType<typeof setInterval> | undefined
  let offset = 0
  let direction: 1 | -1 = 1

  const reset = () => {
    offset = 0
    direction = 1
    const target = getTarget()
    if (target) target.scrollX = 0
  }

  const start = () => {
    if (timer) return
    timer = setInterval(() => {
      const target = getTarget()
      if (!target) return
      const max = Math.max(0, Math.floor(target.scrollWidth - target.width))
      const next = marqueeStep(offset, max, direction)
      offset = next.offset
      direction = next.direction
      target.scrollX = offset
    }, intervalMs)
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
    reset()
  }

  return {
    start,
    stop,
    get active() {
      return timer !== undefined
    },
  }
}
