import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import { readMonitorState } from "../../src/hub/monitor.ts"
import { fallbackStateDir, readHubPointer } from "../../src/hub/paths.ts"
import { detectRemote, localInterfaceHosts } from "../../src/tui/remote.ts"

type Session = Record<string, unknown>
type ProbeContext = {
  readonly app?: { readonly version?: string; readonly channel?: string }
  readonly location?: { readonly directory?: string }
  readonly client: {
    readonly server?: { info: () => Promise<unknown> }
    readonly session: {
      create: (input: { title: string; model?: { id: string; providerID: string } }) => Promise<{ id?: string }>
      prompt: (input: { sessionID: string; text: string; resume?: boolean }) => Promise<{ id?: string }>
      context: (input: { sessionID: string }) => Promise<unknown>
      list?: (input?: { limit?: number }) => Promise<unknown>
    }
  }
  readonly data: {
    readonly on?: (type: string, handler: (event: unknown) => void) => (() => void) | void
    readonly session: {
      list: () => Session[] | undefined
      get: (sessionID: string) => Session | undefined
      root?: (sessionID: string) => string
      family?: (sessionID: string) => string[]
      cost?: (sessionID: string) => number
      status: (sessionID: string) => string
      readonly message: {
        list: (sessionID: string) => Session[]
        sync: (sessionID: string) => Promise<void>
      }
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const maxWait = Math.max(5_000, Math.min(180_000, Number(process.env.SUBPLUG_PROBE_TIMEOUT_MS) || 90_000))
const taskMode = process.env.SUBPLUG_PROBE_TASK === "1"
const replayMode = process.env.SUBPLUG_PROBE_REPLAY === "1"
const toolsMode = process.env.SUBPLUG_PROBE_TOOLS === "1"

async function bounded<T>(operation: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function probeDir(): string {
  return process.env.SUBPLUG_PROBE_DIR ?? join(fallbackStateDir(), "subplug")
}

function write(data: Record<string, unknown>): void {
  try {
    mkdirSync(probeDir(), { recursive: true })
    writeFileSync(join(probeDir(), "tui-state-probe.json"), `${JSON.stringify(data, null, 2)}\n`)
  } catch {
    // The parent harness reports a missing marker as a failure.
  }
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).data
  }
  return value
}

function rows(value: unknown): Session[] {
  const unwrapped = unwrap(unwrap(value))
  return Array.isArray(unwrapped) ? unwrapped.filter((item): item is Session => !!item && typeof item === "object") : []
}

function status(ctx: ProbeContext, sessionID: string): string {
  try {
    return ctx.data.session.status(sessionID)
  } catch {
    return "unknown"
  }
}

function cost(ctx: ProbeContext, sessionID: string): number | undefined {
  try {
    return ctx.data.session.cost?.(sessionID)
  } catch {
    return undefined
  }
}

function model(): { id: string; providerID: string } | undefined {
  const value = process.env.SUBPLUG_PROBE_MODEL?.trim()
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

function safeError(error: unknown): string {
  // Errors from an HTTP client can include URLs, credentials, or prompt text.
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") return code.slice(0, 80)
    const message = String((error as { message?: unknown }).message ?? "").toLowerCase()
    if (message.includes("timed out")) return "probe operation timed out"
    if (message.includes("provider") || message.includes("model") || message.includes("credential")) {
      return "provider or selected model unavailable"
    }
  }
  return "probe operation failed; see client log"
}

function assistantPresent(messages: Session[]): boolean {
  return messages.some((message) =>
    message.type === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((entry: unknown) =>
      !!entry && typeof entry === "object" &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string" &&
      Boolean((entry as { text: string }).text.trim()),
    ),
  )
}

/** Tool names are not private; the event payload omits them, the message does not. */
function toolNames(messages: Session[]): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const entry of message.content) {
      if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "tool") continue
      const name = (entry as { name?: unknown }).name
      if (typeof name === "string" && name) names.add(name)
    }
  }
  return [...names]
}

function sampleSession(ctx: ProbeContext, sessionID: string): Record<string, unknown> {
  const session = ctx.data.session.get(sessionID)
  return {
    id: sessionID,
    inStore: Boolean(session),
    parentID: session?.parentID,
    status: status(ctx, sessionID),
    cost: cost(ctx, sessionID),
    root: ctx.data.session.root?.(sessionID),
    family: ctx.data.session.family?.(sessionID),
  }
}

/** Read the folded session node the server plugin wrote for this session. */
function hubNode(sessionID: string, repoRoot: string | undefined): Record<string, unknown> | undefined {
  try {
    const pointer = readHubPointer()
    if (!pointer) return undefined
    const node = readMonitorState(pointer.hubDir, repoRoot).sessions.find((session) => session.sessionID === sessionID)
    if (!node) return { found: false }
    return {
      found: true,
      kind: node.kind,
      parentID: node.parentID,
      agent: node.agent,
      model: node.model,
      identity: node.identity,
      status: node.status,
    }
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "subplug.probe.tui-state",
  async setup(rawContext) {
    const ctx = rawContext as unknown as ProbeContext
    let disposed = false
    const off: Array<() => void> = []
    void (async () => {
      const startedAt = Date.now()
      const execute = process.env.SUBPLUG_PROBE_EXECUTE === "1"
      const events: Array<{ at: number; type: string; sessionID?: string; parentID?: string; tool?: string; fields: string[] }> = []
      const statuses: Array<{ at: number; value: string }> = []
      const costs: Array<{ at: number; value: number }> = []
      const errors: string[] = []
      let childID: string | undefined
      let rootID: string | undefined
      let taskChildID: string | undefined
      let result: Record<string, unknown> = {}
      try {
        // Register before admitting the prompt. Store only event names, IDs and
        // observation times; event payloads can contain private message text.
        for (const type of [
          "session.created",
          "session.execution.started",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
          "session.step.started",
          "session.step.ended",
          "session.status",
          "session.idle",
          "session.inbox.enqueued",
          "session.inbox.delivered",
          "session.usage.updated",
          "session.tool.called",
          "session.tool.success",
          "session.tool.failed",
        ]) {
          const dispose = ctx.data.on?.(type, (event) => {
            const data = event && typeof event === "object" ? (event as { data?: unknown }).data : undefined
            const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
            const sessionID = typeof record.sessionID === "string" ? record.sessionID : undefined
            const parentID = typeof record.parentID === "string" ? record.parentID : undefined
            // A task-created child announces itself through its parent link.
            if (type === "session.created" && parentID && rootID && parentID === rootID) taskChildID = sessionID
            const watched = [childID, taskChildID].filter((value): value is string => Boolean(value))
            if (watched.length && sessionID && !watched.includes(sessionID)) return
            if (events.length >= 200) return
            // Tool names are not private payload; record them to tell a direct
            // call from a Code Mode `execute` wrapper.
            const tool = [record.tool, record.name, record.toolName].find(
              (value): value is string => typeof value === "string" && value.length > 0,
            )
            events.push({ at: Date.now(), type, sessionID, parentID, tool, fields: Object.keys(record).sort() })
          })
          if (typeof dispose === "function") off.push(dispose)
        }

        const remote = await detectRemote("auto", ctx.location?.directory, {
          info: () => bounded(ctx.client.server?.info() ?? Promise.resolve(undefined), "server info"),
          localHosts: localInterfaceHosts,
          directoryExists: (directory) => Boolean(directory && existsSync(directory)),
        })
        const selectedModel = model()
        if (replayMode) {
          // A late subscriber: sessions and their events already exist on the
          // server before this plugin subscribes. Record only what arrives live.
          const windowMs = Math.max(3_000, Math.min(maxWait, 8_000))
          const deadline = Date.now() + windowMs
          while (!disposed && Date.now() < deadline) await sleep(250)
          const storeList = ctx.data.session.list() ?? []
          result = {
            remote,
            locationAvailable: Boolean(ctx.location?.directory),
            sessionCount: storeList.length,
            replayWindowMs: windowMs,
            storeSessions: storeList
              .map((session) => (typeof session.id === "string" ? session.id : undefined))
              .filter((id): id is string => Boolean(id)),
          }
        } else if (execute && !selectedModel) {
          errors.push("SUBPLUG_PROBE_MODEL must be provider/model for execution mode")
        } else if (taskMode) {
          if (!selectedModel) {
            errors.push("SUBPLUG_PROBE_MODEL must be provider/model for task mode")
          } else {
            const root = await bounded(ctx.client.session.create({ title: "subplug probe root", model: selectedModel }), "root create")
            rootID = root?.id
            if (!rootID) throw new Error("root session has no id")

            const promptAt = Date.now()
            const admitted = await bounded(ctx.client.session.prompt({
              sessionID: rootID,
              text: "Use the task tool exactly once to start a subagent. Tell that subagent to reply with the single word TASK_OK and do nothing else. Then stop.",
            }), "task prompt admission", 20_000)
            const admittedAt = Date.now()

            const childDeadline = Date.now() + maxWait
            while (!disposed && Date.now() < childDeadline && !taskChildID) await sleep(250)

            let sawBusy = false
            let sawIdleAfterBusy = false
            let storeMessages = 0
            if (taskChildID) {
              const idleDeadline = Date.now() + maxWait
              while (!disposed && Date.now() < idleDeadline) {
                const current = status(ctx, taskChildID)
                if (statuses.at(-1)?.value !== current) statuses.push({ at: Date.now(), value: current })
                if (current === "running" || current === "busy") sawBusy = true
                if (sawBusy && current === "idle") { sawIdleAfterBusy = true; break }
                await sleep(250)
              }
              await bounded(ctx.data.session.message.sync(taskChildID), "task message sync").catch(() => undefined)
              storeMessages = ctx.data.session.message.list(taskChildID).length
            }

            const rootSample = sampleSession(ctx, rootID)
            const taskChildSample = taskChildID ? sampleSession(ctx, taskChildID) : undefined
            const folded = taskChildID ? hubNode(taskChildID, ctx.location?.directory) : undefined
            result = {
              remote,
              locationAvailable: Boolean(ctx.location?.directory),
              sessionCount: (ctx.data.session.list() ?? []).length,
              root: rootSample,
              taskChild: taskChildSample,
              taskChildID,
              parentMatches: Boolean(taskChildID && taskChildSample?.parentID === rootID),
              hubNode: folded,
              storeMessages,
              admittedID: admitted?.id,
              promptAt,
              admittedAt,
              admissionMs: admittedAt - promptAt,
              execution: { sawTaskChild: Boolean(taskChildID), sawBusy, sawIdleAfterBusy },
            }
            if (!admitted?.id) errors.push("task prompt admission did not return a message id")
            if (!taskChildID) errors.push("no task-created child session observed")
            if (taskChildID && taskChildSample?.parentID !== rootID) errors.push("task child parentID did not match the root")
            if (!folded || folded.found === false) errors.push("task child was not folded into the hub")
            else {
              if (folded.kind !== "subagent") errors.push("folded task child kind is not subagent")
              if (folded.parentID !== rootID) errors.push("folded task child lost its parent link")
              if (!folded.identity) errors.push("folded task child has no coordination identity")
            }
          }
        } else {
          const root = await bounded(ctx.client.session.create({ title: "subplug probe root", ...(selectedModel ? { model: selectedModel } : {}) }), "root create")
          rootID = root?.id
          if (!rootID) throw new Error("root session has no id")
          const child = await bounded(ctx.client.session.create({ title: "subplug probe scratch", ...(selectedModel ? { model: selectedModel } : {}) }), "scratch create")
          childID = child?.id
          if (!childID) throw new Error("child session has no id")

          const promptAt = Date.now()
          const admitted = await bounded(ctx.client.session.prompt({
            sessionID: childID,
            text: execute
              ? (toolsMode
                  ? "Call the swarm_status tool once with format json, then reply exactly PROBE_TOOL_DONE."
                  : "Reply with exactly PROBE_OK. Do not use tools.")
              : "PROBE_TUI_STATE",
            ...(execute ? {} : { resume: false }),
          }), "prompt admission", 20_000)
          const admittedAt = Date.now()
          let sawBusy = false
          let sawIdleAfterBusy = false
          let sawAssistant = false
          let assistantAt: number | undefined
          let contextMessages = 0
          const deadline = Date.now() + (execute ? maxWait : 2500)
          while (!disposed && Date.now() < deadline) {
            const current = status(ctx, childID)
            if (statuses.at(-1)?.value !== current) statuses.push({ at: Date.now(), value: current })
            const currentCost = cost(ctx, childID)
            if (typeof currentCost === "number" && costs.at(-1)?.value !== currentCost) {
              costs.push({ at: Date.now(), value: currentCost })
            }
            if (current === "running" || current === "busy") sawBusy = true
            if (sawBusy && current === "idle") sawIdleAfterBusy = true
            if (execute || Date.now() + 300 >= deadline) {
              await bounded(ctx.data.session.message.sync(childID), "message sync").catch(() => undefined)
              const store = ctx.data.session.message.list(childID)
              sawAssistant ||= assistantPresent(store)
              if (!sawAssistant) {
                const context = await bounded(ctx.client.session.context({ sessionID: childID }), "context fetch").catch(() => undefined)
                const contextRows = rows(context)
                contextMessages = contextRows.length
                sawAssistant ||= assistantPresent(contextRows)
              }
              if (sawAssistant && !assistantAt) assistantAt = Date.now()
            }
            if (execute && sawBusy && sawIdleAfterBusy && sawAssistant) break
            await sleep(250)
          }

          const clientList = rows(await bounded(ctx.client.session.list?.({ limit: 200 }) ?? Promise.resolve(undefined), "session list").catch(() => undefined))
          const storeList = ctx.data.session.list() ?? []
          const storeMessages = ctx.data.session.message.list(childID)
          const rootSample = sampleSession(ctx, rootID)
          const scratchSample = sampleSession(ctx, childID)
          // Tool names are not private; the tool event omits the name, so read
          // them from the assistant content instead.
          const contextFinal = rows(await bounded(ctx.client.session.context({ sessionID: childID }), "context fetch").catch(() => undefined))
          const toolsUsed = [...new Set([...toolNames(storeMessages), ...toolNames(contextFinal)])]
          result = {
            remote,
            locationAvailable: Boolean(ctx.location?.directory),
            sessionCount: storeList.length,
            clientListCount: clientList.length,
            root: rootSample,
            child: {
              ...scratchSample,
              isTaskChild: false,
              storeMessages: storeMessages.length,
              contextMessages,
              admittedID: admitted?.id,
            },
            promptAt,
            admittedAt,
            admissionMs: admittedAt - promptAt,
            assistantAt,
            toolsUsed,
            execution: execute ? { sawBusy, sawIdleAfterBusy, sawAssistant } : undefined,
          }
          if (!admitted?.id) errors.push("prompt admission did not return a message id")
          if (!rootSample.inStore || !scratchSample.inStore) errors.push("session store did not hydrate the probe sessions")
          if (!storeMessages.length) errors.push("session message store did not show the admitted prompt")
          if (execute && !sawBusy) errors.push("no busy status observed")
          if (execute && !sawIdleAfterBusy) errors.push("no idle status observed after busy")
          if (execute && !sawAssistant) errors.push("no assistant transcript observed")
        }
      } catch (error) {
        errors.push(safeError(error))
      } finally {
        for (const dispose of off) dispose()
        if (!disposed) {
          write({
            schema: 1,
            mode: replayMode ? "replay" : taskMode ? "task" : execute ? "execute" : "hydrate",
            outcome: errors.length
              ? (execute && (
                  !model() ||
                  errors.includes("provider or selected model unavailable") ||
                  (taskMode
                    ? !result.taskChildID
                    : result.execution && !(result.execution as { sawBusy?: boolean }).sawBusy)
                ) ? "incomplete" : "fail")
              : "pass",
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            hostVersion: ctx.app?.version,
            hostChannel: ctx.app?.channel,
            pluginVersion: process.env.SUBPLUG_PROBE_PLUGIN_VERSION,
            model: process.env.SUBPLUG_PROBE_MODEL || undefined,
            ...result,
            events,
            statuses,
            costs,
            errors,
          })
        }
      }
    })()
    return () => {
      disposed = true
      for (const dispose of off) dispose()
    }
  },
})
