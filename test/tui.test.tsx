/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Dashboard, SessionDetail, Sidebar, transcriptLine, type Skin } from "../src/tui/index.tsx"
import type { MonitorState, SessionNode } from "../src/shared/types.ts"
import type { TranscriptRow } from "../src/shared/transcript.ts"

const WIDTH = 100
const HEIGHT = 30

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

function stubApi(): TuiPluginApi {
  return {
    theme: {
      current: {
        backgroundPanel: "#000000",
        border: "#333333",
        text: "#ffffff",
        textMuted: "#888888",
        primary: "#5f87ff",
        error: "#ff0000",
        warning: "#ffaa00",
        success: "#00ff00",
      },
    },
    kv: { get: () => [], set: () => undefined },
    keymap: { registerLayer: () => () => undefined },
    state: {
      session: { get: () => undefined },
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
}

function gap(line: string, left: string, right: string): number {
  const leftEnd = line.indexOf(left) + left.length
  return line.indexOf(right) - leftEnd
}

describe("subplug TUI layout", () => {
  test("dashboard sits inside the host shell with full-width rows and panels", async () => {
    const setup = await renderHosted(() => (
      <Dashboard
        api={stubApi()}
        state={monitorState}
        route="subplug"
        command="subplug.open"
        onClose={() => undefined}
        openSession={() => undefined}
        compose={() => undefined}
      />
    ))
    const lines = setup.captureCharFrame().split("\n")

    const header = lines.find((line) => line.includes("swarm dashboard"))
    expect(header).toBeDefined()
    expect(header?.indexOf("subplug")).toBe(2)
    expect(header?.trimEnd().length).toBe(WIDTH - 2)
    expect(header?.trimEnd().endsWith("ago")).toBe(true)

    const title = lines.find((line) => line.includes("Sessions (2)"))
    expect(title?.indexOf("Sessions")).toBe(4)
    expect(title?.trimEnd().endsWith("│")).toBe(true)
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

  test("a short terminal clips panels instead of overlapping rows", async () => {
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
          api={stubApi()}
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
    const sessionLines = lines.filter((line) => /session \d\d/.test(line))
    expect(sessionLines.length).toBeGreaterThan(2)
    for (const line of sessionLines) {
      expect(line.match(/session \d\d/g)?.length).toBe(1)
      expect(line.startsWith("  │")).toBe(true)
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
