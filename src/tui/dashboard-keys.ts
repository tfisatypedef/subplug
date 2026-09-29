import type { KeyEvent, Renderable } from "@opentui/core"
import { createBindingLookup, type BindingConfig } from "@opentui/keymap/extras"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

type Actions = {
  move: (delta: number) => void
  page: () => number
  jump: (to: "top" | "bottom") => void
  collapse: (value: boolean) => void
  open: () => void
  filter: (delta: number) => void
  group: () => void
  search: () => void
  help: () => void
  compose: () => void
  back: () => void
}

export function registerDashboardKeys(api: TuiPluginApi, actions: Actions) {
  const bindings: BindingConfig<Renderable, KeyEvent> = {
    "subplug.select.next": "down",
    "subplug.select.prev": "up",
    "subplug.page.down": "pagedown",
    "subplug.page.up": "pageup",
    "subplug.jump.top": "home",
    "subplug.jump.bottom": "end",
    "subplug.collapse": "left",
    "subplug.expand": ["right", "space"],
    "subplug.open.selected": "return",
    "subplug.filter.next": "tab",
    "subplug.filter.prev": "shift+tab",
    "subplug.group": "g",
    "subplug.search": "/",
    "subplug.help": ["?", "h"],
    "subplug.compose": ["f", "m"],
    "subplug.dashboard.back": ["escape", "q"],
  }
  const keys = createBindingLookup(bindings)
  return api.keymap.registerLayer({
    priority: 100,
    enabled: () => !api.ui.dialog.open,
    commands: [
      { name: "subplug.select.next", title: "Subplug: next session", category: "Plugin", run: () => actions.move(1) },
      { name: "subplug.select.prev", title: "Subplug: previous session", category: "Plugin", run: () => actions.move(-1) },
      { name: "subplug.page.down", title: "Subplug: page down", category: "Plugin", run: () => actions.move(actions.page()) },
      { name: "subplug.page.up", title: "Subplug: page up", category: "Plugin", run: () => actions.move(-actions.page()) },
      { name: "subplug.jump.top", title: "Subplug: first session", category: "Plugin", run: () => actions.jump("top") },
      { name: "subplug.jump.bottom", title: "Subplug: last session", category: "Plugin", run: () => actions.jump("bottom") },
      { name: "subplug.collapse", title: "Subplug: collapse session", category: "Plugin", run: () => actions.collapse(true) },
      { name: "subplug.expand", title: "Subplug: expand session", category: "Plugin", run: () => actions.collapse(false) },
      { name: "subplug.open.selected", title: "Subplug: open session", category: "Plugin", run: () => actions.open() },
      { name: "subplug.filter.next", title: "Subplug: next filter", category: "Plugin", run: () => actions.filter(1) },
      { name: "subplug.filter.prev", title: "Subplug: previous filter", category: "Plugin", run: () => actions.filter(-1) },
      { name: "subplug.group", title: "Subplug: cycle grouping", category: "Plugin", run: () => actions.group() },
      { name: "subplug.search", title: "Subplug: search sessions", category: "Plugin", run: () => actions.search() },
      { name: "subplug.help", title: "Subplug: toggle help", category: "Plugin", run: () => actions.help() },
      { name: "subplug.compose", title: "Subplug: send follow-up context", category: "Plugin", run: actions.compose },
      { name: "subplug.dashboard.back", title: "Subplug: close dashboard", category: "Plugin", run: actions.back },
    ],
    bindings: keys.gather("subplug.dashboard", Object.keys(bindings)),
  })
}
