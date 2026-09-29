import type {
  EventEnvelope,
  ServerContext,
  SessionPromptEnvelope,
  ToolDefinition,
  ToolEnvelope,
} from "../src/server/index.ts"

export type FakePromptCall = {
  sessionID: string
  text: string
  delivery?: "steer" | "queue"
  resume?: boolean
  id?: string
}

export type V2Fake = {
  ctx: ServerContext
  stream: {
    push: (type: string, data: Record<string, unknown>) => void
  }
  prompts: FakePromptCall[]
  tools: Map<string, ToolDefinition>
  toolBefore: Array<(event: ToolEnvelope) => Promise<void> | void>
  promptHooks: Array<(event: SessionPromptEnvelope) => Promise<void> | void>
  sessionInfo: Map<string, Record<string, unknown>>
  contexts: Map<string, Array<Record<string, unknown>>>
  runToolBefore: (event: ToolEnvelope) => Promise<void>
  runPromptHook: (event: SessionPromptEnvelope) => Promise<void>
}

export function makeV2Context(
  options: Record<string, unknown>,
  directory: string,
  projectID = "v2-test-project",
): V2Fake {
  const queue: EventEnvelope[] = []
  let notify: (() => void) | undefined
  let closed = false
  const wake = () => {
    const resolve = notify
    notify = undefined
    resolve?.()
  }
  const iterator = (signal?: AbortSignal): AsyncIterator<EventEnvelope> => {
    const onAbort = () => {
      closed = true
      wake()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    return {
      async next(): Promise<IteratorResult<EventEnvelope>> {
        for (;;) {
          const item = queue.shift()
          if (item) return { done: false, value: item }
          if (closed) return { done: true, value: undefined }
          await new Promise<void>((resolve) => {
            notify = resolve
          })
        }
      },
      async return(): Promise<IteratorResult<EventEnvelope>> {
        closed = true
        signal?.removeEventListener("abort", onAbort)
        return { done: true, value: undefined }
      },
    }
  }

  const prompts: FakePromptCall[] = []
  const tools = new Map<string, ToolDefinition>()
  const toolBefore: Array<(event: ToolEnvelope) => Promise<void> | void> = []
  const promptHooks: Array<(event: SessionPromptEnvelope) => Promise<void> | void> = []
  const sessionInfo = new Map<string, Record<string, unknown>>()
  const contexts = new Map<string, Array<Record<string, unknown>>>()

  const ctx: ServerContext = {
    options,
    location: { directory, project: { id: projectID } },
    event: { subscribe: (subscribeOptions) => ({ [Symbol.asyncIterator]: () => iterator(subscribeOptions?.signal) }) },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.set(tool.name, tool) })
      },
      hook: async (name, callback) => {
        if (name === "execute.before") toolBefore.push(callback)
      },
    },
    session: {
      hook: async (name, callback) => {
        if (name === "prompt") promptHooks.push(callback)
      },
      get: async ({ sessionID }) => sessionInfo.get(sessionID),
      context: async ({ sessionID }) => contexts.get(sessionID) ?? [],
      prompt: async (input) => {
        prompts.push(input)
        const sequence = String(prompts.length).padStart(4, "0")
        return {
          id: input.id ?? `msg_fake${sequence}000000000000000000`,
          sessionID: input.sessionID,
          type: "user",
          time: { created: Date.now() },
          payload: { text: input.text },
          delivery: input.delivery ?? "steer",
        }
      },
    },
  }

  return {
    ctx,
    stream: {
      push: (type, data) => {
        queue.push({ type, data })
        wake()
      },
    },
    prompts,
    tools,
    toolBefore,
    promptHooks,
    sessionInfo,
    contexts,
    async runToolBefore(event) {
      for (const callback of toolBefore) await callback(event)
    },
    async runPromptHook(event) {
      for (const callback of promptHooks) await callback(event)
    },
  }
}
