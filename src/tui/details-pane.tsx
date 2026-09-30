/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { MonitorState, SessionNode } from "../shared/types.ts"
import { joinClaimsToSessions, lastCommandBySession } from "../hub/monitor.ts"
import { inboxFor } from "../hub/comms.ts"
import { rollupSubtree } from "../hub/tree.ts"
import { buildTranscriptRowsV2, type TranscriptRow } from "../shared/transcript.ts"
import { statusGroupLabel, type StatusGroup } from "./command-center.ts"
import { age, claimLabel, groupColor, groupMark, rollupDetail, sessionLabel, shortID, skinForTheme } from "./presentation.ts"
import { loadTranscriptV2 } from "./data.ts"
import type { TuiContextLike } from "./context.ts"

export function DetailsPane(props: {
  ctx: TuiContextLike
  state: () => MonitorState
  session: SessionNode
  group: StatusGroup
  current: boolean
}) {
  const skin = () => skinForTheme(props.ctx.theme)
  const details = createMemo(() => {
    const state = props.state()
    const id = props.session.sessionID
    return {
      now: state.generatedAt,
      rollup: rollupSubtree(state.sessions, id),
      claims: joinClaimsToSessions(state.registry, state.sessions)
        .filter(({ session }) => session?.sessionID === id)
        .map((holder) => ({
          ...holder,
          conflicts: state.registry.conflicts.filter(
            ({ a, b }) => a === holder.claim.claimID || b === holder.claim.claimID,
          ),
        })),
      inbox: inboxFor(state.comms, id, { now: state.generatedAt }),
      command: lastCommandBySession(state.recentCommands).get(id),
    }
  })
  const [preview, setPreview] = createSignal<string[]>([])

  createEffect(() => {
    const sessionID = props.session.sessionID
    let cancelled = false
    setPreview([])
    void loadTranscriptV2(props.ctx, sessionID)
      .then((source) => {
        if (cancelled) return
        const rows = buildTranscriptRowsV2(source.messages.slice(-20), { now: Date.now() })
        setPreview(
          rows
            .filter((row): row is Extract<TranscriptRow, { kind: "text" }> => row.kind === "text")
            .slice(-4)
            .map((row) => `${row.role}: ${row.text}`),
        )
      })
      .catch(() => undefined)
    onCleanup(() => {
      cancelled = true
    })
  })

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={38}
      minHeight={0}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
      gap={0}
    >
      <text flexShrink={0} fg={skin().accent}>
        <b>Task details</b>
      </text>
      <text flexShrink={0} truncate fg={skin().text}>
        <b>{sessionLabel(props.session)}</b>
      </text>
      <text flexShrink={0} fg={groupColor(skin(), props.group)}>
        {groupMark(props.group, props.session.status)} {statusGroupLabel(props.group)}
        {props.current ? <span style={{ fg: skin().muted }}>  · current</span> : null}
      </text>
      <text flexShrink={0}> </text>
      <text flexShrink={0} fg={skin().muted}>Session</text>
      <text flexShrink={0} fg={skin().text}>{shortID(props.session.sessionID)}</text>
      <text flexShrink={0} fg={skin().muted}>Directory</text>
      <text flexShrink={0} truncate fg={skin().text}>{props.session.directory ?? "—"}</text>
      {props.session.agent ? (
        <text flexShrink={0} truncate fg={skin().text}>
          <span style={{ fg: skin().muted }}>Agent: </span>
          {props.session.agent}
        </text>
      ) : null}
      {props.session.model ? (
        <text flexShrink={0} truncate fg={skin().text}>
          <span style={{ fg: skin().muted }}>Model: </span>
          {props.session.model}
        </text>
      ) : null}
      {props.session.identity ? (
        <text flexShrink={0} truncate fg={skin().muted}>{props.session.identity}</text>
      ) : null}
      <text flexShrink={0}> </text>
      <text flexShrink={0} fg={skin().success}>{rollupDetail(details().rollup)}</text>
      {details().command ? (
        <text flexShrink={0} truncate fg={skin().muted}>
          last {details().command!.category} · {details().command!.summary.slice(0, 40)} ·{" "}
          {age(details().command!.ts, details().now)} ago
        </text>
      ) : null}
      {props.state().source === "remote" && !details().claims.length ? (
        <>
          <text flexShrink={0}> </text>
          <text flexShrink={0} fg={skin().muted}>Claims unavailable on remote attach</text>
        </>
      ) : null}
      {details().claims.length ? (
        <>
          <text flexShrink={0}> </text>
          <text flexShrink={0} fg={skin().accent}>
            <b>Claims ({details().claims.length})</b>
          </text>
          {details().claims.map(({ claim, session, conflicts }) => (
            <box flexShrink={0}>
              <text flexShrink={0} truncate fg={conflicts.length ? skin().error : skin().text}>
                ⇄ {shortID(session!.sessionID)} {claim.claimID.slice(-8)} {claimLabel(claim, details().now)}
              </text>
              {conflicts.map((conflict) => (
                <text flexShrink={0} truncate fg={skin().error}>! {conflict.reason}</text>
              ))}
            </box>
          ))}
        </>
      ) : null}
      {details().inbox.length ? (
        <>
          <text flexShrink={0}> </text>
          <text flexShrink={0} fg={skin().accent}>
            <b>Inbox ({details().inbox.length})</b>
          </text>
          {details().inbox.map((pointer) => (
            <text flexShrink={0} truncate fg={skin().text}>
              <span style={{ fg: skin().muted }}>{pointer.from}</span> {pointer.summary.slice(0, 40)}
            </text>
          ))}
        </>
      ) : null}
      {preview().length ? (
        <>
          <text flexShrink={0}> </text>
          <text flexShrink={0} fg={skin().accent}>
            <b>Recent</b>
          </text>
          {preview().map((line) => (
            <text flexShrink={0} truncate fg={skin().muted}>{line}</text>
          ))}
        </>
      ) : null}
    </box>
  )
}
