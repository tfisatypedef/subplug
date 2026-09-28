/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testRender, type JSX } from "@opentui/solid"
import { registerEnabledFields } from "@opentui/keymap/addons"
import { createTestKeymap } from "@opentui/keymap/testing"
import type { TuiDialogConfirmProps, TuiDialogPromptProps, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createFollowUpComposer, Dashboard, SessionDetail, Sidebar, transcriptLine, type Skin } from "../src/tui/index.tsx"
import { readEventRecords } from "../src/hub/append.ts"
import type { FollowUpRequest } from "../src/shared/follow-up.ts"
import type { MonitorState, SessionNode } from "../src/shared/types.ts"
import type { TranscriptRow } from "../src/shared/transcript.ts"

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

function stubApi(width = WIDTH, height = HEIGHT): TuiPluginApi {
  return {
    theme: {
      current: {
        backgroundPanel: "#000000",
        backgroundElement: "#101010",
        border: "#333333",
        text: "#ffffff",
        textMuted: "#888888",
        primary: "#5f87ff",
        secondary: "#c0c0c0",
        error: "#ff0000",
        warning: "#ffaa00",
        success: "#00ff00",
      },
    },
    kv: { get: () => [], set: () => undefined },
    keymap: { registerLayer: () => () => undefined },
    route: { current: { name: "home" } },
    renderer: { width, height },
    ui: { dialog: { open: false } },
    state: {
      session: { get: () => undefined, permission: () => [], question: () => [] },
      part: () => [],
      provider: { find: () => undefined },
    },
    client: {
      session: {
        todo: async () => ({ data: [] }),
        messages: async () => ({ data: [] }),
      },
    },
  } as unknown as TuiPluginApi
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

describe("subplug TUI layout", () => {
  test("command center renders filter tabs, columns, and a details pane", async () => {
    const setup = await renderHosted(() => (
      <Dashboard
        api={stubApi(WIDTH, HEIGHT)}
        state={monitorState}
        route="subplug"
        command="subplug.open"
        onClose={() => undefined}
        openSession={() => undefined}
        compose={() => undefined}
      />
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

  test("session detail sits inside the host shell with full-width rows and panels", async () => {
    const setup = await renderHosted(() => (
      <SessionDetail
        api={stubApi()}
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

  test("a narrow terminal hides the details pane and keeps rows on one line", async () => {
    const sessions = Array.from({ length: 24 }, (_, index) =>
      session({
        sessionID: `ses_${String(index).padStart(12, "0")}`,
        title: `session ${String(index).padStart(2, "0")}`,
      }),
    )
    const state: MonitorState = { ...monitorState(), sessions }
    const setup = await renderHosted(
      () => (
        <Dashboard
          api={stubApi(60, 14)}
          state={() => state}
          route="subplug"
          command="subplug.open"
          onClose={() => undefined}
          openSession={() => undefined}
          compose={() => undefined}
        />
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
    const setup = await testRender(
      () => <Sidebar state={monitorState} sessionID="ses_root00000001" onOpen={() => (opened += 1)} />,
      { width: 40, height: 12 },
    )
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("ctrl+alt+a")

    setup.mockMouse.click(5, 3)
    await setup.renderOnce()
    expect(opened).toBe(1)
    setup.renderer.destroy()
  })
})

describe("TUI command center keys", () => {
  test("Enter opens the selected session; help toggles before back", async () => {
    const keys = createTestKeymap({ defaultKeys: true })
    registerEnabledFields(keys.keymap)
    const opened: string[] = []
    let backs = 0
    const api = {
      ...stubApi(WIDTH, HEIGHT),
      keymap: keys.keymap,
      route: { current: { name: "session", params: { sessionID: "ses_root00000001" } } },
    } as unknown as TuiPluginApi
    const setup = await renderHosted(() => (
      <Dashboard
        api={api}
        state={monitorState}
        route="subplug"
        command="subplug.open"
        onClose={() => { backs += 1 }}
        openSession={(id) => { opened.push(id) }}
        compose={() => undefined}
      />
    ))
    try {
      keys.host.press("return")
      expect(opened).toEqual(["ses_child0000001"])

      keys.host.press("h")
      keys.host.press("escape")
      expect(backs).toBe(0)
      keys.host.press("escape")
      expect(backs).toBe(1)
      expect(keys.diagnostics.errors).toHaveLength(0)
    } finally {
      setup.renderer.destroy()
      keys.cleanup()
    }
  })
})

describe("TUI dialog keyboard isolation", () => {
  for (const view of ["dashboard", "detail"] as const) {
    test(`${view}: Escape closes the composer before navigating back`, async () => {
      const keys = createTestKeymap({ defaultKeys: true })
      registerEnabledFields(keys.keymap)
      let dialogOpen = false
      let dialogsOpened = 0
      let backs = 0
      let navigations = 0
      let prompt: TuiDialogPromptProps | undefined
      const api = {
        ...stubApi(),
        keymap: keys.keymap,
        ui: {
          DialogPrompt: (props: TuiDialogPromptProps) => { prompt = props; return undefined },
          dialog: {
            get open() { return dialogOpen },
            replace: (render: () => JSX.Element) => { dialogOpen = true; dialogsOpened += 1; render() },
            clear: () => { dialogOpen = false },
          },
        },
      } as unknown as TuiPluginApi
      // Model the host's modal Escape handler below the plugin's priority.
      keys.keymap.registerLayer({
        priority: 10,
        enabled: () => dialogOpen,
        bindings: [{ key: "escape", cmd: () => prompt?.onCancel?.() }],
      })
      const compose = createFollowUpComposer(api, monitorState)
      const setup = await renderHosted(() => view === "dashboard" ? (
        <Dashboard
          api={api} state={monitorState} route="subplug" command="subplug.open"
          onClose={() => { backs += 1 }} openSession={() => { navigations += 1 }} compose={compose}
        />
      ) : (
        <SessionDetail
          api={api} state={monitorState} sessionID={() => "ses_root00000001"}
          trail={() => ["ses_root00000001"]} descend={() => { navigations += 1 }}
          back={() => { backs += 1 }} compose={compose} intervalMs={60_000}
        />
      ))
      try {
        keys.host.press("f")
        expect(dialogOpen).toBe(true)
        expect(dialogsOpened).toBe(1)

        // Text and navigation keys must reach the dialog instead of the view.
        for (const key of ["f", "m", "q", "return", "down"]) keys.host.press(key)
        expect(dialogOpen).toBe(true)
        expect(dialogsOpened).toBe(1)
        expect(backs).toBe(0)
        expect(navigations).toBe(0)

        keys.host.press("escape")
        expect(dialogOpen).toBe(false)
        expect(backs).toBe(0)

        keys.host.press("escape")
        expect(backs).toBe(1)
        expect(keys.diagnostics.errors).toHaveLength(0)
      } finally {
        setup.renderer.destroy()
        keys.cleanup()
      }
    })
  }
})

describe("TUI follow-up composer", () => {
  function setup(status: "idle" | "busy", fail = false) {
    const hubDir = mkdtempSync(join(tmpdir(), "subplug-tui-follow-up-"))
    followUpDirs.push(hubDir)
    const state = { ...monitorState(), hubDir }
    let prompt: TuiDialogPromptProps | undefined
    let confirm: TuiDialogConfirmProps | undefined
    const calls: Array<{ method: string; request: FollowUpRequest }> = []
    const toasts: Array<{ variant: string; message: string }> = []
    const api = {
      client: { session: {
        get: async () => ({ data: { id: "ses_child0000001", agent: "explore" } }),
        status: async () => ({ data: { ses_child0000001: { type: status } } }),
        prompt: async (request: FollowUpRequest) => { calls.push({ method: "prompt", request }); return { data: {} } },
        promptAsync: async (request: FollowUpRequest) => {
          calls.push({ method: "promptAsync", request })
          return fail ? { error: { name: "NotFoundError" } } : { data: undefined }
        },
      } },
      ui: {
        DialogPrompt: (props: TuiDialogPromptProps) => { prompt = props; return undefined },
        DialogConfirm: (props: TuiDialogConfirmProps) => { confirm = props; return undefined },
        dialog: { replace: (render: () => JSX.Element) => render(), clear: () => undefined },
        toast: (toast: { variant: string; message: string }) => { toasts.push(toast) },
      },
    } as unknown as TuiPluginApi
    const compose = createFollowUpComposer(api, () => state)
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(predicate()).toBe(true)
    }
    return { hubDir, compose, calls, toasts, prompt: () => prompt, confirm: () => confirm, waitFor }
  }

  test("targets a subagent, resumes it, and writes its inbox pointer", async () => {
    const harness = setup("idle")
    harness.compose("ses_child0000001", "idle")
    expect(harness.prompt()?.title).toContain("child session")
    harness.prompt()?.onConfirm?.("  Use the new test fixture  ")
    await harness.waitFor(() => harness.toasts.length > 0)
    expect(harness.calls[0]).toMatchObject({ method: "promptAsync", request: {
      sessionID: "ses_child0000001", noReply: false, parts: [{ type: "text", text: "Use the new test fixture" }],
    } })
    expect(readEventRecords(harness.hubDir)[0]).toMatchObject({
      kind: "comms.sent", refs: { from: "user", to: "ses_child0000001", kind: "follow-up", delivery: "prompt" },
    })
    expect(harness.toasts[0]?.variant).toBe("success")
  })

  test("preserves context while confirming a target that became busy", async () => {
    const harness = setup("busy")
    harness.compose("ses_child0000001", "idle")
    harness.prompt()?.onConfirm?.("Follow-up while running")
    await harness.waitFor(() => Boolean(harness.confirm()))
    expect(harness.calls).toHaveLength(0)
    expect(readEventRecords(harness.hubDir)).toHaveLength(0)
    harness.confirm()?.onConfirm?.()
    await harness.waitFor(() => harness.toasts.length > 0)
    expect(harness.calls[0]).toMatchObject({ method: "prompt", request: {
      sessionID: "ses_child0000001", noReply: true, parts: [{ type: "text", text: "Follow-up while running" }],
    } })
    expect(readEventRecords(harness.hubDir)[0]?.refs?.delivery).toBe("queue")
  })

  test("reports an SDK rejection without writing a sent pointer", async () => {
    const harness = setup("idle", true)
    harness.compose("ses_child0000001", "idle")
    harness.prompt()?.onConfirm?.("Context")
    await harness.waitFor(() => harness.toasts.length > 0)
    expect(harness.toasts[0]?.variant).toBe("error")
    expect(harness.toasts[0]?.message).toContain("NotFoundError")
    expect(readEventRecords(harness.hubDir)).toHaveLength(0)
  })
})
