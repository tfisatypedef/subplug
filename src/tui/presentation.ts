import type { RGBA } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
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

export function skinOf(api: TuiPluginApi): Skin {
  const theme = api.theme.current
  return {
    panel: theme.backgroundPanel,
    border: theme.border,
    text: theme.text,
    muted: theme.textMuted,
    accent: theme.primary,
    error: theme.error,
    warning: theme.warning,
    success: theme.success,
    selection: theme.backgroundElement ?? theme.backgroundPanel,
    secondary: theme.secondary ?? theme.textMuted,
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
