import { networkInterfaces } from "node:os"

/**
 * How the TUI decides whether it is attached to a server on another machine.
 * `"auto"` probes the attached endpoint; `"remote"`/`"local"` force the answer.
 */
export type RemoteMode = "auto" | "remote" | "local"

export function parseRemoteMode(value: unknown): RemoteMode {
  if (value === true) return "remote"
  if (value === false) return "local"
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "remote" || normalized === "true" || normalized === "1") return "remote"
    if (normalized === "local" || normalized === "false" || normalized === "0") return "local"
  }
  return "auto"
}

/** Every host this machine answers on, including loopback. */
export function localInterfaceHosts(): Set<string> {
  const hosts = new Set<string>(["127.0.0.1", "localhost", "::1"])
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.address) hosts.add(address.address)
    }
  }
  return hosts
}

export function serverUrls(info: unknown): string[] {
  const urls = info && typeof info === "object" ? (info as { urls?: unknown }).urls : undefined
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string" && url.length > 0) : []
}

/**
 * `true` when every advertised server URL points at a host this machine does not
 * own. `undefined` when there is nothing to judge (no urls).
 */
export function urlsIndicateRemote(urls: readonly string[], localHosts: ReadonlySet<string>): boolean | undefined {
  if (!urls.length) return undefined
  return urls.every((url) => {
    try {
      return !localHosts.has(new URL(url).hostname)
    } catch {
      return true
    }
  })
}

export type RemoteDeps = {
  /** The attached server's `/api/info` payload. */
  info: () => Promise<unknown>
  /** Local interface hosts; injectable for tests. */
  localHosts: () => ReadonlySet<string>
  /** Whether `ctx.location.directory` exists on this machine. */
  directoryExists: (directory: string | undefined) => boolean
}

/**
 * Decide local vs remote. Explicit mode always wins. Auto prefers the urls
 * heuristic; when the endpoint is silent it falls back to whether the session
 * directory exists locally, then to local (the safe default).
 */
export async function detectRemote(
  mode: RemoteMode,
  directory: string | undefined,
  deps: RemoteDeps,
): Promise<boolean> {
  if (mode === "remote") return true
  if (mode === "local") return false
  let info: unknown
  try {
    info = await deps.info()
  } catch {
    info = undefined
  }
  const signal = urlsIndicateRemote(serverUrls(info), deps.localHosts())
  if (signal !== undefined) return signal
  if (directory) return !deps.directoryExists(directory)
  return false
}
