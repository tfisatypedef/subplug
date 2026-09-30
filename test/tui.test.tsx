/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RGBA, TextRenderable } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createFollowUpComposer, Dashboard, SessionDetail, Sidebar, transcriptLine, type Skin } from "../src/tui/index.tsx"
import { DetailsPane } from "../src/tui/details-pane.tsx"
import { createSessionNavigator } from "../src/tui/navigation.ts"
import { readEventRecords } from "../src/hub/append.ts"
import type { MonitorState, SessionNode } from "../src/shared/types.ts"
import type { TranscriptRow, V2Message } from "../src/shared/transcript.ts"
import type { TuiContextLike, TuiKeymapCommand, TuiRoute } from "../src/tui/context.ts"

const WIDTH = 100
const HEIGHT = 30
const followUpDirs: string[] = []
afterEach(() => {
  for (const dir of followUpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function session(overrides: Partial<SessionNode> & { sessionID: string }): SessionNode {
  return { kind: "root", status: "idle", lastEventAt: 1000, ...overrides }
}

function monitorState(): MonitorState {
  return {
    generatedAt: 2000,
    hubDir: "/tmp/hub",
    sessions: [
      session({ sessionID: "ses_root00000001", title: "root session" }),
      session({ sessionID: "ses_child0000001", title: "child session", kind: "subagent", parentID: "ses_root00000001" }),
    ],
    risks: [],
    recentCommands: [],
    comms: [],
    registry: { claims: [], verifications: [], conflicts: [], errors: [] },
  }
}

type Theme = TuiContextLike["theme"]

function stubTheme(overrides: { text?: string; muted?: string } = {}): Theme {
  return {
    text: {
      base: RGBA.fromHex(overrides.text ?? "#ffffff"),
      muted: RGBA.fromHex(overrides.muted ?? "#888888"),
      action: { primary: { base: RGBA.fromHex("#5f87ff") }, secondary: { base: RGBA.fromHex("#c0c0c0") } },
      feedback: {
        error: { base: RGBA.fromHex("#ff0000") },
        warning: { base: RGBA.fromHex("#ffaa00") },
        success: { base: RGBA.fromHex("#00ff00") },
        info: { base: RGBA.fromHex("#00aaff") },
      },
    },
    background: { base: RGBA.fromHex("#000000"), raised: { base: RGBA.fromHex("#101010") } },
    border: { base: RGBA.fromHex("#333333") },
  }
}

type Stub = {
  ctx: TuiContextLike
  commands: () => TuiKeymapCommand[]
  press: (id: string) => Promise<void>
  toasts: Array<{ variant?: string; title?: string; message: string }>
  dialogPrompts: Array<Record<string, unknown>>
  dialogConfirms: Array<Record<string, unknown>>
  queuePrompt: (value: string | undefined) => void
  queueConfirm: (value: boolean | undefined) => void
  navigations: TuiRoute[]
  pages: Map<string, (input: { data?: Record<string, unknown> }) => JSX.Element>
  preferences: Map<string, unknown>
  promptCalls: Array<{ sessionID: string; text: string; delivery?: "steer" | "queue" }>
  contextMessages: Map<string, V2Message[]>
  sessionInfo: Map<string, Record<string, unknown>>
  setRoute: (route: TuiRoute) => void
}

function stubCtx(width = WIDTH, height = HEIGHT): Stub {
  const layers: TuiKeymapCommand[] = []
  const toasts: Stub["toasts"] = []
  const dialogPrompts: Array<Record<string, unknown>> = []
  const dialogConfirms: Array<Record<string, unknown>> = []
  const promptQueue: Array<string | undefined> = []
  const confirmQueue: Array<boolean | undefined> = []
  const navigations: TuiRoute[] = []
  const pages = new Map<string, (input: { data?: Record<string, unknown> }) => JSX.Element>()
  const preferences = new Map<string, unknown>()
  const promptCalls: Stub["promptCalls"] = []
  const contextMessages = new Map<string, V2Message[]>()
  const sessionInfo = new Map<string, Record<string, unknown>>()
  const messageStore = new Map<string, V2Message[]>()
  let route: TuiRoute = { type: "home" }
  let promptCounter = 0

  const ctx: TuiContextLike = {
    options: {},
    location: { directory: "/tmp/project" },
    app: { version: "test", channel: "test" },
    renderer: {
      width,
      height,
      terminalWidth: width,
      terminalHeight: height,
      resolution: { width: width * 8, height: height * 16 },
    },
    theme: stubTheme(),
    attention: { notify: async () => ({ ok: true }) },
    storage: {
      store: (key, options) => {
        const holder = { ...options.initial }
        preferences.set(key, holder)
        return [
          holder,
          (mutation) => {
            mutation(holder)
          },
        ]
      },
    },
    keymap: {
      layer: (input) => {
        layers.push(...(input().commands ?? []))
      },
    },
    ui: {
      dialog: {
        prompt: async (options) => {
          dialogPrompts.push(options)
          return promptQueue.shift()
        },
        confirm: async (options) => {
          dialogConfirms.push(options)
          return confirmQueue.shift()
        },
        clear: () => undefined,
      },
      toast: { show: (options) => toasts.push(options) },
      router: {
        register: (page) => {
          pages.set(page.name, page.render)
          return () => pages.delete(page.name)
        },
        navigate: (destination) => navigations.push(destination),
        current: () => route,
      },
      slot: () => () => undefined,
    },
    data: {
      session: {
        list: () => [],
        get: (sessionID) => sessionInfo.get(sessionID),
        status: () => "idle",
        message: {
          list: (sessionID) => messageStore.get(sessionID) ?? [],
          sync: async () => undefined,
        },
        permission: { list: () => [] },
        form: { list: () => [] },
      },
      project: { list: () => [{ id: "project-1", canonical: "/tmp/project" }] },
      location: { model: { list: () => [{ id: "test/model", limit: { context: 200_000 } }] } },
      on: () => () => undefined,
    },
    client: {
      session: {
        get: async (input) => sessionInfo.get(input.sessionID),
        context: async (input) => ({ data: contextMessages.get(input.sessionID) ?? [] }),
        list: async () => ({ data: { data: [], cursor: {} } }),
        prompt: async (input) => {
          promptCalls.push(input)
          promptCounter += 1
          return { id: `msg_host${String(promptCounter).padStart(4, "0")}` }
        },
      },
    },
  }

  return {
    ctx,
    commands: () => layers,
    press: async (id) => {
      const command = [...layers].reverse().find((entry) => entry.id === id)
      if (!command) throw new Error(`missing command ${id}`)
      await command.run?.()
    },
    toasts,
    dialogPrompts,
    dialogConfirms,
    queuePrompt: (value) => promptQueue.push(value),
    queueConfirm: (value) => confirmQueue.push(value),
    navigations,
    pages,
    preferences,
    promptCalls,
    contextMessages,
    sessionInfo,
    setRoute: (next) => {
      route = next
    },
  }
}

async function renderHosted(node: () => JSX.Element, width = WIDTH, height = HEIGHT) {
  const setup = await testRender(
    () => (
      <box width={width} height={height} flexDirection="column">
        <box flexGrow={1} minHeight={0} flexDirection="column">
          {node()}
        </box>
      </box>
    ),
    { width, height },
  )
  await setup.flush()
  return setup
}

const SKIN: Skin = {
  panel: "#000000",
  border: "#333333",
  text: "#ffffff",
  muted: "#888888",
  accent: "#5f87ff",
  error: "#ff0000",
  warning: "#ffaa00",
  success: "#00ff00",
  selection: "#101010",
  secondary: "#c0c0c0",
}

function gap(line: string, left: string, right: string): number {
  const leftEnd = line.indexOf(left) + left.length
  return line.indexOf(right) - leftEnd
}

function texts(node: import("@opentui/core").Renderable): TextRenderable[] {
  return node instanceof TextRenderable ? [node] : node.getChildren().flatMap(texts)
}

describe("subplug TUI layout", () => {
  test("command center renders filter tabs, columns, and a details pane", async () => {
    const stub = stubCtx(WIDTH, HEIGHT)
    const setup = await renderHosted(() => (
      <Dashboard ctx={stub.ctx} state={monitorState} onClose={() => undefined} openSession={() => undefined} compose={() => undefined} />
    ))
    const lines = setup.captureCharFrame().split("\n")

    const header = lines.find((line) => line.includes("command center"))
    expect(header).toBeDefined()
    expect(header?.indexOf("subplug")).toBe(2)
    expect(header?.includes("Group: Project")).toBe(true)
    expect(header?.includes("claims")).toBe(true)

    const filters = lines.find((line) => line.includes("All 2"))
    expect(filters).toBeDefined()
    expect(filters?.includes("Needs you 0")).toBe(true)
    expect(filters?.includes("Ready 2")).toBe(true)

    const columns = lines.find((line) => line.includes("Tasks") && line.includes("Status"))
    expect(columns).toBeDefined()
    expect(lines.some((line) => line.includes("Task details"))).toBe(true)
    expect(lines.some((line) => line.includes("root session"))).toBe(true)
    setup.renderer.destroy()
  })

  test("marks the session the dashboard was opened from as current", async () => {
    const stub = stubCtx(WIDTH, HEIGHT)
    const setup = await renderHosted(() => (
      <Dashboard
        ctx={stub.ctx}
        state={monitorState}
        currentSession={() => "ses_child0000001"}
        onClose={() => undefined}
        openSession={() => undefined}
        compose={() => undefined}
      />
    ))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("• child session")
    // The parent is selected first in the nested list; step to the child to
    // surface the detail pane's current marker.
    await stub.press("subplug.select.next")
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("· current")
    setup.renderer.destroy()
  })

  test("session detail sits inside the host shell with full-width rows and panels", async () => {
    const stub = stubCtx()
    const setup = await renderHosted(() => (
      <SessionDetail
        ctx={stub.ctx}
        state={monitorState}
        sessionID={() => "ses_root00000001"}
        trail={() => ["ses_root00000001"]}
        descend={() => undefined}
        back={() => undefined}
        compose={() => undefined}
        intervalMs={60_000}
      />
    ))
    const lines = setup.captureCharFrame().split("\n")

    const header = lines.find((line) => line.includes("session detail"))
    expect(header).toBeDefined()
    expect(header?.indexOf("subplug")).toBe(2)
    expect(header?.trimEnd().length).toBe(WIDTH - 2)
    expect(header?.trimEnd().endsWith("esc/q back")).toBe(true)

    const conversation = lines.find((line) => line.includes("Conversation ("))
    expect(conversation?.indexOf("Conversation")).toBe(4)
    expect(conversation?.trimEnd().endsWith("│")).toBe(true)
    expect(gap(conversation ?? "", "Conversation (0 rows)", "↑/↓ subagent")).toBeGreaterThan(10)

    const todos = lines.find((line) => line.includes("Todos ("))
    expect(todos?.trimEnd().endsWith("│")).toBe(true)
    setup.renderer.destroy()
  })

  test("session detail ignores stale and disposed transcript loads and stops polling after close", async () => {
    const stub = stubCtx()
    const [selected, setSelected] = createSignal("ses_root00000001")
    const pending: Array<{ sessionID: string; resolve: (value: unknown) => void }> = []
    stub.ctx.client.session.context = ({ sessionID }) =>
      new Promise((resolve) => pending.push({ sessionID, resolve }))
    const setup = await renderHosted(() => (
      <SessionDetail
        ctx={stub.ctx}
        state={monitorState}
        sessionID={selected}
        trail={() => [selected()]}
        descend={() => undefined}
        back={() => undefined}
        compose={() => undefined}
        intervalMs={500}
      />
    ))
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(predicate()).toBe(true)
    }
    try {
      await waitFor(() => pending.some((request) => request.sessionID === "ses_root00000001"))
      setSelected("ses_child0000001")
      await waitFor(() => pending.some((request) => request.sessionID === "ses_child0000001"))
      const childLoad = pending.find((request) => request.sessionID === "ses_child0000001")!
      childLoad.resolve({ data: [{ type: "user", text: "CURRENT_CHILD_TRANSCRIPT" }] })
      await waitFor(() => setup.captureCharFrame().includes("CURRENT_CHILD_TRANSCRIPT"))

      const rootLoad = pending.find((request) => request.sessionID === "ses_root00000001")!
      rootLoad.resolve({ data: [{ type: "user", text: "STALE_ROOT_TRANSCRIPT" }] })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("CURRENT_CHILD_TRANSCRIPT")
      expect(setup.captureCharFrame()).not.toContain("STALE_ROOT_TRANSCRIPT")

      await waitFor(() => pending.length >= 3)
      const disposedLoad = pending[2]!
      const callsAtClose = pending.length
      setup.renderer.destroy()
      disposedLoad.resolve({ data: [{ type: "user", text: "LATE_DISPOSED_TRANSCRIPT" }] })
      await new Promise((resolve) => setTimeout(resolve, 550))
      expect(pending.length).toBe(callsAtClose)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("a narrow terminal hides the details pane and keeps rows on one line", async () => {
    const sessions = Array.from({ length: 24 }, (_, index) =>
      session({
        sessionID: `ses_${String(index).padStart(12, "0")}`,
        title: `session ${String(index).padStart(2, "0")}`,
      }),
    )
    const state: MonitorState = { ...monitorState(), sessions }
    const stub = stubCtx(60, 14)
    const setup = await renderHosted(
      () => (
        <Dashboard ctx={stub.ctx} state={() => state} onClose={() => undefined} openSession={() => undefined} compose={() => undefined} />
      ),
      60,
      14,
    )
    const lines = setup.captureCharFrame().split("\n")
    expect(lines.some((line) => line.includes("Task details"))).toBe(false)
    const sessionLines = lines.filter((line) => /session \d\d/.test(line))
    expect(sessionLines.length).toBeGreaterThan(0)
    for (const line of sessionLines) {
      expect(line.match(/session \d\d/g)?.length).toBe(1)
    }
    setup.renderer.destroy()
  })

  test("multi-line tool output reserves its rows", async () => {
    const rows: TranscriptRow[] = [
      {
        kind: "tool",
        key: "t1",
        tool: "bash",
        status: "completed",
        title: "run",
        elapsedMs: 1200,
        outputTail: "line one\nline two",
      },
      { kind: "text", key: "t2", role: "assistant", text: "MARKER_AFTER_TOOL" },
    ]
    const setup = await testRender(
      () => (
        <box width={60} height={6} flexDirection="column">
          <box flexShrink={1} minHeight={0} overflow="hidden" border flexDirection="column">
            {rows.map((row) => transcriptLine(row, SKIN))}
          </box>
        </box>
      ),
      { width: 60, height: 6 },
    )
    await setup.flush()
    const lines = setup.captureCharFrame().split("\n")
    const tailLine = lines.findIndex((line) => line.includes("line two"))
    const markerLine = lines.findIndex((line) => line.includes("MARKER_AFTER_TOOL"))
    expect(tailLine).toBeGreaterThanOrEqual(0)
    expect(markerLine).toBeGreaterThan(tailLine)
    expect(lines[markerLine]?.includes("line two")).toBe(false)
    setup.renderer.destroy()
  })

  test("sidebar shows the open hint and forwards clicks", async () => {
    let opened = 0
    const stub = stubCtx(40, 42)
    const setup = await testRender(
      () => (
        <Sidebar ctx={stub.ctx} state={monitorState} sessionID="ses_root00000001" onOpen={() => (opened += 1)} />
      ),
      { width: 40, height: 42 },
    )
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("ctrl+alt+a")

    setup.mockMouse.click(5, 3)
    await setup.renderOnce()
    expect(opened).toBe(1)
    setup.renderer.destroy()
  })

  test("sidebar renders a square, themed panel capped at five sessions", async () => {
    const sessions = Array.from({ length: 8 }, (_, index) =>
      session({
        sessionID: `ses_${String(index).padStart(12, "0")}`,
        title: `session ${String(index).padStart(2, "0")}`,
        lastEventAt: 1000 + index,
      }),
    )
    const state: MonitorState = { ...monitorState(), sessions }
    const stub = stubCtx(42, 40)
    ;(stub.ctx as unknown as Record<string, unknown>).theme = stubTheme({ text: "#123456", muted: "#654321" })
    const setup = await testRender(
      () => <Sidebar ctx={stub.ctx} state={() => state} sessionID="ses_000000000007" onOpen={() => undefined} />,
      { width: 42, height: 40 },
    )
    await setup.flush()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const top = lines.find((line) => line.includes("┌") && line.includes("┐"))
    const bottom = lines.find((line) => line.includes("└") && line.includes("┘"))
    expect(top).toBeDefined()
    expect(bottom).toBeDefined()
    expect((top?.indexOf("┐") ?? 0) - (top?.indexOf("┌") ?? 0) + 1).toBe(36)
    expect((bottom ? lines.indexOf(bottom) : 0) - (top ? lines.indexOf(top) : 0) + 1).toBe(18)
    expect(frame).toContain("session 03")
    expect(frame).toContain("session 07")
    expect(frame).not.toContain("session 00")
    expect(frame).not.toContain("session 01")
    expect(frame).not.toContain("session 02")
    expect(frame.match(/session 03/g)?.length).toBe(1)

    const rendered = texts(setup.renderer.root)
    expect(rendered.find((line) => line.plainText.includes("Agents"))?.fg.equals(RGBA.fromHex("#123456"))).toBe(true)
    expect(rendered.find((line) => line.plainText.includes("session 03"))?.fg.equals(RGBA.fromHex("#654321"))).toBe(true)
    setup.renderer.destroy()
  })

  test("sidebar derives its height from the terminal cell aspect", async () => {
    const tall = stubCtx(42, 40)
    ;(tall.ctx as unknown as Record<string, unknown>).renderer = {
      ...tall.ctx.renderer,
      resolution: { width: 42 * 8, height: 40 * 23 },
    }
    const setup = await testRender(
      () => <Sidebar ctx={tall.ctx} state={monitorState} sessionID="ses_root00000001" onOpen={() => undefined} />,
      { width: 42, height: 40 },
    )
    await setup.flush()
    const lines = setup.captureCharFrame().split("\n")
    const top = lines.find((line) => line.includes("┌") && line.includes("┐"))
    const bottom = lines.find((line) => line.includes("└") && line.includes("┘"))
    expect((top?.indexOf("┐") ?? 0) - (top?.indexOf("┌") ?? 0) + 1).toBe(36)
    expect((bottom ? lines.indexOf(bottom) : 0) - (top ? lines.indexOf(top) : 0) + 1).toBe(13)
    setup.renderer.destroy()
  })

  test("sidebar aspect falls back and clamps when the terminal reports no pixels", async () => {
    const noPixels = stubCtx(42, 40)
    ;(noPixels.ctx as unknown as Record<string, unknown>).renderer = { ...noPixels.ctx.renderer, resolution: null }
    const heightOf = async (aspect: number) => {
      const setup = await testRender(
        () => (
          <Sidebar ctx={noPixels.ctx} aspect={aspect} state={monitorState} sessionID="ses_root00000001" onOpen={() => undefined} />
        ),
        { width: 42, height: 40 },
      )
      await setup.flush()
      const lines = setup.captureCharFrame().split("\n")
      const top = lines.find((line) => line.includes("┌") && line.includes("┐"))
      const bottom = lines.find((line) => line.includes("└") && line.includes("┘"))
      const value = (bottom ? lines.indexOf(bottom) : 0) - (top ? lines.indexOf(top) : 0) + 1
      setup.renderer.destroy()
      return value
    }
    expect(await heightOf(0.2)).toBe(11)
    expect(await heightOf(0.9)).toBe(24)
  })

  test("hovering a truncated sidebar row marquees its title", async () => {
    const title = "a session title that is far too long for the square panel"
    const state: MonitorState = {
      ...monitorState(),
      sessions: [session({ sessionID: "ses_root00000001", title })],
    }
    const stub = stubCtx(42, 40)
    const setup = await testRender(
      () => <Sidebar ctx={stub.ctx} state={() => state} sessionID="ses_other0000001" onOpen={() => undefined} />,
      { width: 42, height: 40 },
    )
    await setup.flush()
    const before = setup.captureCharFrame()
    await setup.mockMouse.moveTo(5, 2)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toBe(before)
    setup.renderer.destroy()
  })

  test("details mark joined claims and color conflicting claims", async () => {
    const node = session({ sessionID: "ses_owner0000001", identity: "agent" })
    const state: MonitorState = {
      ...monitorState(), sessions: [node],
      registry: {
        claims: ["conflict", "clean"].map((id) => ({
          claimID: id, agent: "agent", status: "active", issued: new Date(0).toISOString(),
          expires: new Date(100000).toISOString(), note: "",
          scopes: { patterns: [], files: [], docs: [], evidence: [], baton: null },
        })),
        verifications: [], errors: [], conflicts: [{ a: "other", b: "conflict", reason: "overlapping file" }],
      },
    }
    const stub = stubCtx()
    const setup = await testRender(() => (
      <DetailsPane ctx={stub.ctx} state={() => state} session={node} group="ready" current={false} />
    ), { width: 50, height: 30 })
    await setup.flush()
    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain("⇄ ses_owne")
      expect(frame).toContain("! overlapping file")
      const lines = texts(setup.renderer.root)
      expect(lines.find((line) => line.plainText.includes("conflict"))?.fg.equals(RGBA.fromHex("#ff0000"))).toBe(true)
      expect(lines.find((line) => line.plainText.includes("clean"))?.fg.equals(RGBA.fromHex("#ffffff"))).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("TUI command center keys", () => {
  test("Enter uses the navigator for cached, remote, and missing sessions", async () => {
    const routes: TuiRoute[] = []
    const selected: string[] = []
    const notices: string[] = []
    const id = "ses_empty0000001"

    const build = (mode: "cached" | "remote" | "failure") => {
      const stub = stubCtx()
      stub.setRoute({ type: "home" })
      const ui = (stub.ctx as unknown as { ui: { router: { navigate: unknown }; toast: { show: unknown } } }).ui
      ui.router.navigate = (destination: TuiRoute) => routes.push(destination)
      ui.toast.show = (toast: { message: string }) => notices.push(toast.message)
      if (mode === "cached") stub.sessionInfo.set(id, { id })
      stub.ctx.client.session.get = async (input) => {
        if (mode === "failure") throw new Error("Host unavailable")
        if (mode === "remote") return undefined
        return stub.sessionInfo.get(input.sessionID)
      }
      return stub
    }

    for (const mode of ["cached", "remote", "failure"] as const) {
      routes.length = 0
      selected.length = 0
      notices.length = 0
      const stub = build(mode)
      const navigate = createSessionNavigator(stub.ctx, "swarm", (value) => selected.push(value))
      if (mode === "cached") {
        await navigate(id)
        expect(routes).toEqual([{ type: "session", sessionID: id }])
        expect(selected).toEqual([])
        expect(notices).toEqual([])
        continue
      }
      if (mode === "remote") {
        await navigate(id)
        expect(routes).toEqual([{ type: "plugin", name: "swarm.session", data: { sessionID: id } }])
        expect(selected).toEqual([id])
        expect(notices).toEqual([])
        continue
      }
      await navigate(id)
      expect(routes).toEqual([])
      expect(selected).toEqual([])
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("Host unavailable")
    }
  })

  test("search filters the list and back clears it before leaving", async () => {
    let backs = 0
    const opened: string[] = []
    const stub = stubCtx()
    const setup = await renderHosted(() => (
      <Dashboard ctx={stub.ctx} state={monitorState} onClose={() => { backs += 1 }} openSession={(id) => opened.push(id)} compose={() => undefined} />
    ))
    try {
      stub.queuePrompt(" ROOT ")
      await stub.press("subplug.search")
      await setup.flush()
      expect(stub.dialogPrompts.at(-1)?.title).toBe("Search sessions")
      await new Promise((resolve) => setTimeout(resolve, 0))
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("Search: ROOT")
      expect(setup.captureCharFrame()).not.toContain("child session")

      await stub.press("subplug.open.selected")
      expect(opened).toEqual(["ses_root00000001"])

      stub.queuePrompt("no-match")
      await stub.press("subplug.search")
      expect(stub.dialogPrompts.at(-1)?.value).toBe("ROOT")
      await new Promise((resolve) => setTimeout(resolve, 0))
      await setup.flush()
      expect(setup.captureCharFrame()).toContain("no matching sessions")

      await stub.press("subplug.dashboard.back")
      expect(backs).toBe(0)
      await setup.flush()
      await stub.press("subplug.dashboard.back")
      expect(backs).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("tabs filter, grouping persists, and collapse acts in a nested project", async () => {
    const opened: string[] = []
    const stub = stubCtx()
    const setup = await renderHosted(() => (
      <Dashboard ctx={stub.ctx} state={monitorState} onClose={() => undefined} openSession={(id) => opened.push(id)} compose={() => undefined} />
    ))
    try {
      // Break away flattens the project list; the child is then the newest row.
      await stub.press("subplug.breakAway")
      await setup.flush()
      expect((stub.preferences.get("preferences") as { flat?: boolean }).flat).toBe(true)
      await stub.press("subplug.open.selected")
      expect(opened).toEqual(["ses_child0000001"])

      // Filtering to Needs you leaves no tasks, so opening is a no-op.
      await stub.press("subplug.filter.next")
      await stub.press("subplug.open.selected")
      expect(opened).toEqual(["ses_child0000001"])
      await stub.press("subplug.filter.prev")

      // Back to nested: collapse hides the child and persists.
      await stub.press("subplug.breakAway")
      await setup.flush()
      expect((stub.preferences.get("preferences") as { flat?: boolean }).flat).toBe(false)
      await stub.press("subplug.collapse")
      expect((stub.preferences.get("preferences") as { collapsed?: string[] }).collapsed).toEqual(["ses_root00000001"])
      await stub.press("subplug.expand")
      expect((stub.preferences.get("preferences") as { collapsed?: string[] }).collapsed).toEqual([])

      await stub.press("subplug.group")
      expect((stub.preferences.get("preferences") as { grouping?: string }).grouping).toBe("status")
      await stub.press("subplug.group")
      expect((stub.preferences.get("preferences") as { grouping?: string }).grouping).toBe("agent")
      await stub.press("subplug.group")
      expect((stub.preferences.get("preferences") as { grouping?: string }).grouping).toBe("hierarchy")
      await stub.press("subplug.collapse")
      expect((stub.preferences.get("preferences") as { collapsed?: string[] }).collapsed).toEqual(["ses_root00000001"])
      await stub.press("subplug.expand")
      expect((stub.preferences.get("preferences") as { collapsed?: string[] }).collapsed).toEqual([])
      expect(opened).toHaveLength(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("paging and home/end select the expected sessions", async () => {
    const opened: string[] = []
    const stub = stubCtx(80, 20)
    const state = {
      ...monitorState(),
      sessions: Array.from({ length: 30 }, (_, index) =>
        session({ sessionID: `ses_${String(index).padStart(2, "0")}`, lastEventAt: 30 - index }),
      ),
    }
    const setup = await renderHosted(
      () => <Dashboard ctx={stub.ctx} state={() => state} onClose={() => undefined} openSession={(id) => opened.push(id)} compose={() => undefined} />,
      80,
      20,
    )
    try {
      for (const id of ["subplug.page.down", "subplug.open.selected", "subplug.page.up", "subplug.open.selected", "subplug.jump.bottom", "subplug.open.selected", "subplug.jump.top", "subplug.open.selected"]) {
        await stub.press(id)
      }
      expect(opened).toEqual(["ses_11", "ses_00", "ses_29", "ses_00"])
    } finally {
      setup.renderer.destroy()
    }
  })

  test("Enter opens the selected session; help toggles before back", async () => {
    const opened: string[] = []
    let backs = 0
    const stub = stubCtx()
    const setup = await renderHosted(() => (
      <Dashboard ctx={stub.ctx} state={monitorState} onClose={() => { backs += 1 }} openSession={(id) => { opened.push(id) }} compose={() => undefined} />
    ))
    try {
      await stub.press("subplug.open.selected")
      expect(opened).toEqual(["ses_root00000001"])

      await stub.press("subplug.help")
      await setup.flush()
      await stub.press("subplug.dashboard.back")
      expect(backs).toBe(0)
      await stub.press("subplug.dashboard.back")
      expect(backs).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe("TUI follow-up composer", () => {
  function setup(status: "idle" | "busy" | "unknown", fail = false, remote = false) {
    const hubDir = mkdtempSync(join(tmpdir(), "subplug-tui-follow-up-"))
    followUpDirs.push(hubDir)
    const state = {
      ...monitorState(),
      hubDir: remote ? "" : hubDir,
      source: remote ? "remote" as const : "hub" as const,
      sessions: [
        session({ sessionID: "ses_child0000001", title: "child session", kind: "subagent", parentID: "ses_root00000001", status }),
      ],
    }
    const stub = stubCtx()
    stub.sessionInfo.set("ses_child0000001", { id: "ses_child0000001" })
    if (fail) {
      stub.ctx.client.session.prompt = async () => {
        throw new Error("NotFoundError")
      }
    }
    const compose = createFollowUpComposer(stub.ctx, () => state)
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(predicate()).toBe(true)
    }
    return { hubDir, compose, stub, waitFor }
  }

  test("targets a subagent, steers it, and writes its inbox pointer", async () => {
    const harness = setup("idle")
    harness.stub.queuePrompt("  Use the new test fixture  ")
    await harness.compose("ses_child0000001", "idle")
    await harness.waitFor(() => harness.stub.toasts.length > 0)
    expect(harness.stub.dialogPrompts[0]?.title).toContain("child session")
    expect(harness.stub.promptCalls[0]).toMatchObject({
      sessionID: "ses_child0000001",
      text: "Use the new test fixture",
      delivery: "steer",
    })
    expect(readEventRecords(harness.hubDir)[0]).toMatchObject({
      kind: "comms.sent", refs: { from: "user", to: "ses_child0000001", kind: "follow-up", delivery: "prompt" },
    })
    expect(harness.stub.toasts[0]?.variant).toBe("success")
  })

  test("preserves context while confirming a target that became busy", async () => {
    const harness = setup("busy")
    harness.stub.queuePrompt("Follow-up while running")
    harness.stub.queueConfirm(true)
    await harness.compose("ses_child0000001", "idle")
    await harness.waitFor(() => harness.stub.toasts.length > 0)
    expect(harness.stub.dialogConfirms).toHaveLength(1)
    expect(harness.stub.promptCalls[0]).toMatchObject({
      sessionID: "ses_child0000001",
      text: "Follow-up while running",
      delivery: "queue",
    })
    expect(readEventRecords(harness.hubDir)[0]?.refs?.delivery).toBe("queue")

    const cancelled = setup("busy")
    cancelled.stub.queuePrompt("Follow-up while running")
    cancelled.stub.queueConfirm(false)
    await cancelled.compose("ses_child0000001", "idle")
    expect(cancelled.stub.promptCalls).toHaveLength(0)
    expect(readEventRecords(cancelled.hubDir)).toHaveLength(0)
  })

  test("reports a native rejection without writing a sent pointer", async () => {
    const harness = setup("idle", true)
    harness.stub.queuePrompt("Context")
    await harness.compose("ses_child0000001", "idle")
    await harness.waitFor(() => harness.stub.toasts.length > 0)
    expect(harness.stub.toasts[0]?.variant).toBe("error")
    expect(harness.stub.toasts[0]?.message).toContain("NotFoundError")
    expect(readEventRecords(harness.hubDir)).toHaveLength(0)
  })

  test("unknown remote status requires confirmation, queues once, and never writes a local pointer", async () => {
    const cancelled = setup("unknown", false, true)
    cancelled.stub.queuePrompt("Remote follow-up")
    cancelled.stub.queueConfirm(false)
    await cancelled.compose("ses_child0000001", "unknown")
    expect(cancelled.stub.dialogConfirms).toHaveLength(1)
    expect(cancelled.stub.promptCalls).toHaveLength(0)
    expect(readEventRecords(cancelled.hubDir)).toHaveLength(0)

    const confirmed = setup("unknown", false, true)
    confirmed.stub.queuePrompt("Remote follow-up")
    confirmed.stub.queueConfirm(true)
    await confirmed.compose("ses_child0000001", "unknown")
    await confirmed.waitFor(() => confirmed.stub.toasts.length > 0)
    expect(confirmed.stub.dialogConfirms).toHaveLength(1)
    expect(confirmed.stub.promptCalls).toEqual([{
      sessionID: "ses_child0000001",
      text: "Remote follow-up",
      delivery: "queue",
    }])
    expect(readEventRecords(confirmed.hubDir)).toHaveLength(0)
  })
})
