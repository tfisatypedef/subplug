import type { SessionNode } from "../shared/types.ts"

export type SessionTreeNode = {
  session: SessionNode
  depth: number
  children: SessionTreeNode[]
  orphan: boolean
}

export type SessionTree = {
  roots: SessionTreeNode[]
  orphans: SessionTreeNode[]
}

export type TreeRow = {
  session: SessionNode
  depth: number
  hasChildren: boolean
  collapsed: boolean
  orphan: boolean
}

export type SubtreeRollup = {
  total: number
  busy: number
  retry: number
  error: number
  deleted: number
  cost: number
}

function byRecencyAsc(a: SessionNode, b: SessionNode): number {
  return a.lastEventAt - b.lastEventAt || a.sessionID.localeCompare(b.sessionID)
}

function byRecencyDesc(a: SessionNode, b: SessionNode): number {
  return b.lastEventAt - a.lastEventAt || a.sessionID.localeCompare(b.sessionID)
}

export function buildSessionTree(sessions: SessionNode[]): SessionTree {
  const ordered = [...sessions].sort(byRecencyAsc)
  const nodes = new Map<string, SessionTreeNode>()
  for (const session of ordered) {
    nodes.set(session.sessionID, { session, depth: 0, children: [], orphan: false })
  }

  const parentOf = (node: SessionTreeNode): SessionTreeNode | undefined => {
    const parentID = node.session.parentID
    if (!parentID || parentID === node.session.sessionID) return undefined
    return nodes.get(parentID)
  }

  const childrenOf = new Map<string, SessionTreeNode[]>()
  for (const node of nodes.values()) {
    const parent = parentOf(node)
    if (!parent) continue
    const list = childrenOf.get(parent.session.sessionID)
    if (list) list.push(node)
    else childrenOf.set(parent.session.sessionID, [node])
  }

  const placed = new Set<string>()
  const walk = (node: SessionTreeNode, depth: number, orphan: boolean): void => {
    if (placed.has(node.session.sessionID)) return
    placed.add(node.session.sessionID)
    node.depth = depth
    node.orphan = orphan
    const children: SessionTreeNode[] = []
    for (const child of childrenOf.get(node.session.sessionID) ?? []) {
      if (placed.has(child.session.sessionID)) continue
      walk(child, depth + 1, orphan)
      children.push(child)
    }
    node.children = children
  }

  const roots: SessionTreeNode[] = []
  const orphans: SessionTreeNode[] = []
  for (const node of nodes.values()) {
    const parentID = node.session.parentID
    if (parentID && parentID !== node.session.sessionID) continue
    roots.push(node)
    walk(node, 0, false)
  }
  for (const node of nodes.values()) {
    const parentID = node.session.parentID
    if (!parentID || parentID === node.session.sessionID || nodes.has(parentID)) continue
    if (placed.has(node.session.sessionID)) continue
    orphans.push(node)
    walk(node, 0, true)
  }
  for (const node of nodes.values()) {
    if (placed.has(node.session.sessionID)) continue
    orphans.push(node)
    walk(node, 0, true)
  }

  roots.sort((a, b) => byRecencyDesc(a.session, b.session))
  orphans.sort((a, b) => byRecencyDesc(a.session, b.session))
  return { roots, orphans }
}

export function flattenTree(tree: SessionTree, collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const push = (node: SessionTreeNode): void => {
    const isCollapsed = collapsed.has(node.session.sessionID)
    rows.push({
      session: node.session,
      depth: node.depth,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed,
      orphan: node.orphan,
    })
    if (isCollapsed) return
    for (const child of node.children) push(child)
  }
  for (const root of tree.roots) push(root)
  for (const orphan of tree.orphans) push(orphan)
  return rows
}

export function rollupSubtree(sessions: SessionNode[], sessionID: string): SubtreeRollup {
  const byID = new Map(sessions.map((session) => [session.sessionID, session]))
  const childrenOf = new Map<string, string[]>()
  for (const session of sessions) {
    const parentID = session.parentID
    if (!parentID || parentID === session.sessionID) continue
    const list = childrenOf.get(parentID)
    if (list) list.push(session.sessionID)
    else childrenOf.set(parentID, [session.sessionID])
  }

  const rollup: SubtreeRollup = { total: 0, busy: 0, retry: 0, error: 0, deleted: 0, cost: 0 }
  const seen = new Set<string>()
  const stack = [sessionID]
  while (stack.length) {
    const id = stack.pop()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const session = byID.get(id)
    if (!session) continue
    rollup.total += 1
    if (session.status === "busy") rollup.busy += 1
    else if (session.status === "retry") rollup.retry += 1
    else if (session.status === "error") rollup.error += 1
    if (session.deleted) rollup.deleted += 1
    rollup.cost += session.cost ?? 0
    for (const child of childrenOf.get(id) ?? []) stack.push(child)
  }
  return rollup
}
