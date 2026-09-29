import type { JSX } from "@opentui/solid"
import type { V2ModelInfo, V2SessionInfo } from "./data.ts"
import type { V2Message } from "../shared/transcript.ts"
import type { ThemeLike } from "./presentation.ts"

export type TuiRoute =
  | { readonly type: "home" }
  | { readonly type: "session"; readonly sessionID: string }
  | { readonly type: "plugin"; readonly name: string; readonly data?: Record<string, unknown> }

export type TuiKeymapCommand = {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly enabled?: boolean | (() => boolean)
  readonly bind?: false | string
  readonly palette?: true
  readonly slash?: { readonly name: string; readonly aliases?: readonly string[]; readonly arguments?: true }
  readonly suggested?: boolean | (() => boolean)
  readonly run: (input?: string, event?: unknown) => void | false | Promise<void>
}

export type TuiKeymapLayer = {
  readonly mode?: string
  readonly enabled?: boolean | (() => boolean)
  readonly priority?: number
  readonly commands?: readonly TuiKeymapCommand[]
}

export type TuiDialog = {
  readonly prompt: (options: {
    readonly title: string
    readonly description?: string
    readonly placeholder?: string
    readonly value?: string
  }) => Promise<string | undefined>
  readonly confirm: (options: {
    readonly title: string
    readonly message: string
    readonly label?: { readonly confirm?: string; readonly cancel?: string }
  }) => Promise<boolean | undefined>
  readonly clear: () => void
}

export type TuiToast = {
  readonly show: (options: {
    readonly title?: string
    readonly message: string
    readonly variant?: "info" | "success" | "warning" | "error"
    readonly duration?: number
    readonly sessionID?: string
  }) => void
}

export type TuiPage = {
  readonly name: string
  readonly render: (input: { readonly data?: Record<string, unknown> }) => JSX.Element
}

export type TuiSlotClaim = {
  readonly render: (input: { readonly sessionID: string }) => JSX.Element
} & (
  | { readonly append: string; readonly prepend?: never; readonly before?: never; readonly after?: never; readonly replace?: never }
  | { readonly prepend: string; readonly append?: never; readonly before?: never; readonly after?: never; readonly replace?: never }
  | { readonly before: string; readonly append?: never; readonly prepend?: never; readonly after?: never; readonly replace?: never }
  | { readonly after: string; readonly append?: never; readonly prepend?: never; readonly before?: never; readonly replace?: never }
  | { readonly replace: string; readonly append?: never; readonly prepend?: never; readonly before?: never; readonly after?: never }
)

export type TuiContextLike = {
  readonly options?: Readonly<Record<string, unknown>>
  readonly location?: { readonly directory?: string } | undefined
  readonly app?: { readonly version?: string; readonly channel?: string }
  readonly renderer?: {
    readonly width?: number
    readonly height?: number
    readonly terminalWidth?: number
    readonly terminalHeight?: number
    readonly resolution?: { readonly width: number; readonly height: number } | null
  }
  readonly theme: ThemeLike
  readonly attention: { readonly notify: (options: Record<string, unknown>) => Promise<unknown> }
  readonly storage: {
    readonly store: <Value extends object>(
      key: string,
      options: { readonly initial: Value },
    ) => readonly [Value, (mutation: (draft: Value) => void) => Promise<void> | void]
  }
  readonly keymap: { readonly layer: (input: () => TuiKeymapLayer) => void }
  readonly ui: {
    readonly dialog: TuiDialog
    readonly toast: TuiToast
    readonly router: {
      readonly register: (page: TuiPage) => () => void
      readonly navigate: (destination: TuiRoute) => void
      readonly current: () => TuiRoute
    }
    readonly slot: (claim: TuiSlotClaim) => () => void
  }
  readonly data: {
    readonly session: {
      list: () => V2SessionInfo[] | undefined
      get: (sessionID: string) => V2SessionInfo | undefined
      status: (sessionID: string) => "idle" | "running"
      readonly message: {
        list: (sessionID: string) => V2Message[]
        sync: (sessionID: string) => Promise<void>
      }
      readonly permission?: { list: (sessionID: string) => unknown[] | undefined }
      readonly form?: { list: (sessionID: string) => unknown[] | undefined }
    }
    readonly project?: { list: () => Array<{ readonly id?: string; readonly canonical?: string }> }
    readonly location?: { readonly model?: { list: () => V2ModelInfo[] | undefined } }
    readonly on?: (type: string, handler: (event: unknown) => void) => (() => void) | void
  }
  readonly client: {
    readonly session: {
      get: (input: { readonly sessionID: string }) => Promise<unknown>
      context: (input: { readonly sessionID: string }) => Promise<unknown>
      list?: (input?: { readonly limit?: number }) => Promise<unknown>
      prompt: (input: {
        readonly sessionID: string
        readonly text: string
        readonly delivery?: "steer" | "queue"
        readonly resume?: boolean
        readonly id?: string
      }) => Promise<unknown>
    }
  }
}

export type SubplugTuiOptions = {
  route: string
  intervalMs: number
  sidebarAspect: number
  storageDir?: string
  hubGroup?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pick(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function resolveTuiOptions(options?: Readonly<Record<string, unknown>>): SubplugTuiOptions {
  const coord = record(options?.coord) ? options.coord : undefined
  return {
    route: pick(options?.route, "subplug"),
    intervalMs: Math.max(250, num(options?.intervalMs, 1000)),
    sidebarAspect: num(options?.sidebarAspect, 0.5),
    storageDir:
      pick(options?.storageDir, "") ||
      pick(coord?.storageDir, "") ||
      process.env.SUBPLUG_STORAGE_DIR ||
      undefined,
    hubGroup: pick(options?.hubGroup, "") || pick(coord?.hubGroup, "") || process.env.SUBPLUG_HUB_GROUP || undefined,
  }
}
