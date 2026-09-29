import type { TuiContextLike } from "./context.ts"

function sessionIDOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === "string" && id ? id : undefined
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}

export function createSessionNavigator(ctx: TuiContextLike, route: string, select: (sessionID: string) => void) {
  const openDetail = (sessionID: string) => {
    select(sessionID)
    ctx.ui.router.navigate({ type: "plugin", name: `${route}.session`, data: { sessionID } })
  }
  return async (sessionID: string): Promise<void> => {
    try {
      if (ctx.data.session.get(sessionID)) {
        ctx.ui.router.navigate({ type: "session", sessionID })
        return
      }
      // The sync store omits empty sessions; the host client is authoritative.
      const native = await ctx.client.session.get({ sessionID })
      if (sessionIDOf(native)) {
        ctx.ui.router.navigate({ type: "session", sessionID })
        return
      }
      openDetail(sessionID)
    } catch (error) {
      if (statusOf(error) === 404) {
        openDetail(sessionID)
        return
      }
      ctx.ui.toast.show({
        variant: "error",
        title: "subplug",
        message: error instanceof Error ? error.message : "Session lookup failed",
        duration: 5000,
      })
    }
  }
}
