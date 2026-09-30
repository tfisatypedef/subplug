import type { TuiContextLike, TuiKeymapLayer } from "./context.ts"

export type DashboardActions = {
  move: (delta: number) => void
  page: () => number
  jump: (to: "top" | "bottom") => void
  collapse: (value: boolean) => void
  open: () => void
  filter: (delta: number) => void
  group: () => void
  breakAway: () => void
  search: () => void
  help: () => void
  compose: () => void
  back: () => void
}

export const DASHBOARD_LAYER = (actions: DashboardActions): TuiKeymapLayer => ({
  priority: 100,
  commands: [
    { id: "subplug.select.next", title: "Subplug: next session", group: "Plugin", bind: "down", run: () => actions.move(1) },
    { id: "subplug.select.prev", title: "Subplug: previous session", group: "Plugin", bind: "up", run: () => actions.move(-1) },
    {
      id: "subplug.page.down",
      title: "Subplug: page down",
      group: "Plugin",
      bind: "pagedown",
      run: () => actions.move(actions.page()),
    },
    {
      id: "subplug.page.up",
      title: "Subplug: page up",
      group: "Plugin",
      bind: "pageup",
      run: () => actions.move(-actions.page()),
    },
    { id: "subplug.jump.top", title: "Subplug: first session", group: "Plugin", bind: "home", run: () => actions.jump("top") },
    { id: "subplug.jump.bottom", title: "Subplug: last session", group: "Plugin", bind: "end", run: () => actions.jump("bottom") },
    { id: "subplug.collapse", title: "Subplug: collapse session", group: "Plugin", bind: "left", run: () => actions.collapse(true) },
    { id: "subplug.expand", title: "Subplug: expand session", group: "Plugin", bind: "right", run: () => actions.collapse(false) },
    { id: "subplug.open.selected", title: "Subplug: open session", group: "Plugin", bind: "return", run: () => actions.open() },
    { id: "subplug.filter.next", title: "Subplug: next filter", group: "Plugin", bind: "tab", run: () => actions.filter(1) },
    {
      id: "subplug.filter.prev",
      title: "Subplug: previous filter",
      group: "Plugin",
      bind: "shift+tab",
      run: () => actions.filter(-1),
    },
    { id: "subplug.group", title: "Subplug: cycle grouping", group: "Plugin", bind: "g", run: () => actions.group() },
    {
      id: "subplug.breakAway",
      title: "Subplug: break subagents out of their parents",
      group: "Plugin",
      bind: "b",
      run: () => actions.breakAway(),
    },
    { id: "subplug.search", title: "Subplug: search sessions", group: "Plugin", bind: "/", run: () => actions.search() },
    { id: "subplug.help", title: "Subplug: toggle help", group: "Plugin", bind: "?", run: () => actions.help() },
    { id: "subplug.compose", title: "Subplug: send follow-up context", group: "Plugin", bind: "f", run: () => actions.compose() },
    { id: "subplug.dashboard.back", title: "Subplug: close dashboard", group: "Plugin", bind: "escape", run: () => actions.back() },
    { bind: "q", run: () => actions.back() },
    { bind: "m", run: () => actions.compose() },
    { bind: "h", run: () => actions.help() },
    { bind: "space", run: () => actions.collapse(false) },
  ],
})

export function registerDashboardKeys(ctx: TuiContextLike, actions: DashboardActions): void {
  ctx.keymap.layer(() => DASHBOARD_LAYER(actions))
}
