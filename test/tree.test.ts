import { describe, expect, test } from "bun:test"
import { buildSessionTree, flattenTree, rollupSubtree } from "../src/hub/tree.ts"
import type { SessionNode } from "../src/shared/types.ts"

function session(overrides: Partial<SessionNode> & { sessionID: string }): SessionNode {
  return { kind: "root", status: "idle", lastEventAt: 1000, ...overrides }
}

describe("buildSessionTree", () => {
  test("nests children by parentID and computes depth", () => {
    const tree = buildSessionTree([
      session({ sessionID: "root", lastEventAt: 1 }),
      session({ sessionID: "child", parentID: "root", lastEventAt: 2, status: "busy" }),
      session({ sessionID: "grand", parentID: "child", lastEventAt: 3 }),
    ])

    expect(tree.orphans).toEqual([])
    expect(tree.roots.length).toBe(1)
    expect(tree.roots[0]?.session.sessionID).toBe("root")
    expect(tree.roots[0]?.depth).toBe(0)
    expect(tree.roots[0]?.children[0]?.session.sessionID).toBe("child")
    expect(tree.roots[0]?.children[0]?.depth).toBe(1)
    expect(tree.roots[0]?.children[0]?.children[0]?.session.sessionID).toBe("grand")
    expect(tree.roots[0]?.children[0]?.children[0]?.depth).toBe(2)
  })

  test("orders roots newest first and children oldest first", () => {
    const tree = buildSessionTree([
      session({ sessionID: "old-root", lastEventAt: 10 }),
      session({ sessionID: "new-root", lastEventAt: 30 }),
      session({ sessionID: "later-child", parentID: "old-root", lastEventAt: 40 }),
      session({ sessionID: "early-child", parentID: "old-root", lastEventAt: 20 }),
    ])

    expect(tree.roots.map((node) => node.session.sessionID)).toEqual(["new-root", "old-root"])
    expect(tree.roots[1]?.children.map((node) => node.session.sessionID)).toEqual(["early-child", "later-child"])
  })

  test("treats missing parents as orphan roots and retains deleted nodes", () => {
    const tree = buildSessionTree([
      session({ sessionID: "root", lastEventAt: 1 }),
      session({ sessionID: "lost", parentID: "ghost", lastEventAt: 2, deleted: true }),
      session({ sessionID: "lost-child", parentID: "lost", lastEventAt: 3 }),
    ])

    expect(tree.roots.map((node) => node.session.sessionID)).toEqual(["root"])
    expect(tree.orphans.length).toBe(1)
    expect(tree.orphans[0]?.session.sessionID).toBe("lost")
    expect(tree.orphans[0]?.orphan).toBe(true)
    expect(tree.orphans[0]?.session.deleted).toBe(true)
    expect(tree.orphans[0]?.children[0]?.session.sessionID).toBe("lost-child")
    expect(tree.orphans[0]?.children[0]?.orphan).toBe(true)
  })

  test("breaks cycles without duplicating or dropping nodes", () => {
    const tree = buildSessionTree([
      session({ sessionID: "a", parentID: "b", lastEventAt: 1 }),
      session({ sessionID: "b", parentID: "a", lastEventAt: 2 }),
      session({ sessionID: "self", parentID: "self", lastEventAt: 3 }),
    ])

    expect(tree.roots.map((node) => node.session.sessionID)).toEqual(["self"])
    expect(tree.orphans.length).toBe(1)
    expect(tree.orphans[0]?.session.sessionID).toBe("a")
    expect(tree.orphans[0]?.children[0]?.session.sessionID).toBe("b")
    const rows = flattenTree(tree, new Set())
    expect(rows.map((row) => row.session.sessionID).sort()).toEqual(["a", "b", "self"])
  })
})

describe("flattenTree", () => {
  const tree = buildSessionTree([
    session({ sessionID: "root", lastEventAt: 1 }),
    session({ sessionID: "child", parentID: "root", lastEventAt: 2 }),
    session({ sessionID: "grand", parentID: "child", lastEventAt: 3 }),
    session({ sessionID: "orphan", parentID: "missing", lastEventAt: 4 }),
  ])

  test("emits visible rows pre-order with markers", () => {
    const rows = flattenTree(tree, new Set())
    expect(rows.map((row) => row.session.sessionID)).toEqual(["root", "child", "grand", "orphan"])
    expect(rows[0]?.hasChildren).toBe(true)
    expect(rows[2]?.hasChildren).toBe(false)
    expect(rows[3]?.orphan).toBe(true)
    expect(rows[3]?.depth).toBe(0)
  })

  test("hides descendants of collapsed nodes but keeps their row", () => {
    const rows = flattenTree(tree, new Set(["child"]))
    expect(rows.map((row) => row.session.sessionID)).toEqual(["root", "child", "orphan"])
    expect(rows[1]?.collapsed).toBe(true)
    expect(rows[1]?.hasChildren).toBe(true)
  })
})

describe("rollupSubtree", () => {
  test("counts descendants, statuses, deletions, and cost", () => {
    const sessions = [
      session({ sessionID: "root", lastEventAt: 1, status: "busy", cost: 50 }),
      session({ sessionID: "a", parentID: "root", lastEventAt: 2, status: "busy", cost: 25 }),
      session({ sessionID: "b", parentID: "root", lastEventAt: 3, status: "error", cost: 10 }),
      session({ sessionID: "c", parentID: "a", lastEventAt: 4, status: "retry", deleted: true }),
      session({ sessionID: "unrelated", lastEventAt: 5 }),
    ]

    expect(rollupSubtree(sessions, "root")).toEqual({
      total: 4,
      busy: 2,
      retry: 1,
      error: 1,
      deleted: 1,
      cost: 85,
    })
  })

  test("returns zeros for an unknown session and survives cycles", () => {
    expect(rollupSubtree([], "missing")).toEqual({ total: 0, busy: 0, retry: 0, error: 0, deleted: 0, cost: 0 })
    const cyclic = rollupSubtree(
      [session({ sessionID: "a", parentID: "b" }), session({ sessionID: "b", parentID: "a" })],
      "a",
    )
    expect(cyclic.total).toBe(2)
  })
})
