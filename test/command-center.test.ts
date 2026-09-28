import { describe, expect, test } from "bun:test"
import type { SessionNode } from "../src/shared/types.ts"
import {
  buildCenterRows,
  clampWindow,
  createMarquee,
  filterCounts,
  GROUPINGS,
  isGrouping,
  marqueeStep,
  nextGrouping,
  selectedDisplayIndex,
  statusGroup,
  statusGroupLabel,
  taskIndexByDisplay,
  taskPositions,
  TASK_FILTERS,
  type MarqueeTarget,
} from "../src/tui/command-center.ts"

function session(overrides: Partial<SessionNode> & { sessionID: string }): SessionNode {
  return { kind: "root", status: "idle", lastEventAt: 1000, ...overrides }
}

describe("command center status groups", () => {
  test("maps session status to a group", () => {
    expect(statusGroup(session({ sessionID: "a", status: "error" }))).toBe("needs")
    expect(statusGroup(session({ sessionID: "b", status: "busy" }))).toBe("working")
    expect(statusGroup(session({ sessionID: "c", status: "retry" }))).toBe("working")
    expect(statusGroup(session({ sessionID: "d", status: "idle" }))).toBe("ready")
    expect(statusGroup(session({ sessionID: "e", status: "unknown" }))).toBe("inactive")
    expect(statusGroup(session({ sessionID: "f", status: "idle", deleted: true }))).toBe("inactive")
  })

  test("live needs-input and deletion take precedence", () => {
    expect(statusGroup(session({ sessionID: "a", status: "busy" }), true)).toBe("needs")
    expect(statusGroup(session({ sessionID: "b", status: "idle", deleted: true }), true)).toBe("needs")
  })

  test("labels match the filter vocabulary", () => {
    expect(statusGroupLabel("needs")).toBe("Needs input")
    expect(statusGroupLabel("working")).toBe("Working")
    expect(statusGroupLabel("ready")).toBe("Ready")
    expect(statusGroupLabel("inactive")).toBe("Inactive")
  })

  test("counts each filter including the All bucket", () => {
    const sessions = [
      session({ sessionID: "a", status: "error" }),
      session({ sessionID: "b", status: "busy" }),
      session({ sessionID: "c", status: "idle" }),
      session({ sessionID: "d", status: "idle", deleted: true }),
    ]
    expect(filterCounts(sessions)).toEqual([4, 1, 1, 1, 1])
    expect(filterCounts(sessions, new Set(["b"]))).toEqual([4, 2, 0, 1, 1])
  })

  test("grouping cycles through every mode", () => {
    expect(GROUPINGS).toHaveLength(4)
    expect(nextGrouping("project")).toBe("status")
    expect(nextGrouping("hierarchy")).toBe("project")
    expect(isGrouping("agent")).toBe(true)
    expect(isGrouping("nope")).toBe(false)
  })
})

describe("command center rows", () => {
  const sessions = [
    session({ sessionID: "root", title: "root", directory: "/work/a", lastEventAt: 10 }),
    session({ sessionID: "child", title: "child", kind: "subagent", parentID: "root", directory: "/work/a", lastEventAt: 20 }),
    session({ sessionID: "other", title: "other", directory: "/work/b", lastEventAt: 30, status: "busy" }),
  ]

  test("project grouping emits group headers and recency-ordered tasks", () => {
    const { rows, tasks } = buildCenterRows(sessions, { filter: null, search: "", grouping: "project" })
    const headers = rows.filter((row) => row.kind === "group")
    expect(headers.map((row) => row.label)).toEqual(["/work/a", "/work/b"])
    expect(tasks.map((task) => task.session.sessionID)).toEqual(["child", "root", "other"])
    expect(rows.some((row) => row.kind === "gap")).toBe(true)
  })

  test("status grouping orders needs, working, ready, inactive", () => {
    const mixed = [
      session({ sessionID: "ready", status: "idle" }),
      session({ sessionID: "working", status: "busy" }),
      session({ sessionID: "needs", status: "error" }),
      session({ sessionID: "inactive", status: "unknown" }),
    ]
    const { rows } = buildCenterRows(mixed, { filter: null, search: "", grouping: "status" })
    const labels = rows.filter((row) => row.kind === "group").map((row) => row.label)
    expect(labels).toEqual(["Needs input", "Working", "Ready", "Inactive"])
  })

  test("agent grouping labels missing agents", () => {
    const { rows } = buildCenterRows(
      [
        session({ sessionID: "a", agent: "build" }),
        session({ sessionID: "b", agent: "build" }),
        session({ sessionID: "c" }),
      ],
      { filter: null, search: "", grouping: "agent" },
    )
    const headers = rows.filter((row) => row.kind === "group")
    expect(headers.map((row) => row.label)).toEqual(["(no agent)", "build"])
  })

  test("hierarchy grouping nests children and honours collapse", () => {
    const expanded = buildCenterRows(sessions, { filter: null, search: "", grouping: "hierarchy" })
    expect(expanded.tasks.find((task) => task.session.sessionID === "child")?.depth).toBe(1)
    const collapsed = buildCenterRows(sessions, {
      filter: null,
      search: "",
      grouping: "hierarchy",
      collapsed: new Set(["root"]),
    })
    const root = collapsed.tasks.find((task) => task.session.sessionID === "root")
    expect(collapsed.tasks.some((task) => task.session.sessionID === "child")).toBe(false)
    expect(root?.hasChildren).toBe(true)
    expect(root?.collapsed).toBe(true)
  })

  test("filter and search narrow the task list", () => {
    const filtered = buildCenterRows(sessions, { filter: "working", search: "", grouping: "project" })
    expect(filtered.tasks.map((task) => task.session.sessionID)).toEqual(["other"])
    const searched = buildCenterRows(sessions, { filter: null, search: "child", grouping: "project" })
    expect(searched.tasks.map((task) => task.session.sessionID)).toEqual(["child"])
  })

  test("selection maps between task and display indices", () => {
    const { rows } = buildCenterRows(sessions, { filter: null, search: "", grouping: "project" })
    const positions = taskPositions(rows)
    expect(positions).toHaveLength(3)
    expect(selectedDisplayIndex(rows, 0)).toBe(positions[0] ?? -1)
    expect(selectedDisplayIndex(rows, 99)).toBe(positions[positions.length - 1] ?? -1)
    const map = taskIndexByDisplay(rows)
    expect(map.filter((value) => value >= 0)).toEqual([0, 1, 2])
    expect(map[positions[0] as number] ?? -1).toBe(0)
  })

  test("window scrolls to keep the selection visible", () => {
    expect(clampWindow(5, 2, 10)).toBe(0)
    expect(clampWindow(100, 50, 10)).toBe(45)
    expect(clampWindow(100, 0, 10)).toBe(0)
    expect(clampWindow(100, 99, 10)).toBe(90)
  })

  test("every task filter is a known group or the All bucket", () => {
    for (const filter of TASK_FILTERS) {
      if (filter.group !== null) expect(["needs", "working", "ready", "inactive"]).toContain(filter.group)
    }
  })
})

describe("command center marquee", () => {
  test("marqueeStep ping-pongs between the ends", () => {
    expect(marqueeStep(4, 10, 1)).toEqual({ offset: 5, direction: 1 })
    expect(marqueeStep(10, 10, 1)).toEqual({ offset: 10, direction: -1 })
    expect(marqueeStep(10, 10, -1)).toEqual({ offset: 9, direction: -1 })
    expect(marqueeStep(0, 10, -1)).toEqual({ offset: 0, direction: 1 })
  })

  test("marqueeStep stays put when there is nothing to scroll", () => {
    expect(marqueeStep(3, 0, 1)).toEqual({ offset: 0, direction: 1 })
  })

  test("createMarquee advances the target and resets on stop", async () => {
    const target: MarqueeTarget = { width: 10, scrollWidth: 14, scrollX: 0 }
    const marquee = createMarquee(() => target, { intervalMs: 5 })
    expect(marquee.active).toBe(false)
    marquee.start()
    expect(marquee.active).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(target.scrollX).toBeGreaterThan(0)
    marquee.stop()
    expect(marquee.active).toBe(false)
    expect(target.scrollX).toBe(0)
  })

  test("createMarquee tolerates a missing target and a no-op width", async () => {
    const missing = createMarquee(() => undefined, { intervalMs: 5 })
    missing.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    missing.stop()
    const target: MarqueeTarget = { width: 40, scrollWidth: 40, scrollX: 0 }
    const marquee = createMarquee(() => target, { intervalMs: 5 })
    marquee.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(target.scrollX).toBe(0)
    marquee.stop()
  })
})
