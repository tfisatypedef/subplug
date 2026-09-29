import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hubPointerFile, readHubPointer, writeHubPointer } from "../src/hub/paths.ts"

const original = process.env.XDG_STATE_HOME

afterEach(() => {
  if (original === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = original
})

function tempXdg(): string {
  const dir = mkdtempSync(join(tmpdir(), "subplug-pointer-"))
  process.env.XDG_STATE_HOME = dir
  return dir
}

describe("hub pointer", () => {
  test("round-trips the resolved hub and expires stale pointers", () => {
    const xdg = tempXdg()
    try {
      writeHubPointer({ hubDir: "/tmp/hub-a", group: "shared", at: 1000 })
      expect(hubPointerFile()).toBe(join(xdg, "opencode", "subplug", "hub.json"))
      expect(readHubPointer(2000)).toEqual({ hubDir: "/tmp/hub-a", group: "shared", at: 1000 })
      expect(readHubPointer(1000 + 8 * 24 * 60 * 60 * 1000)).toBeUndefined()
    } finally {
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  test("returns undefined when missing or malformed", () => {
    const xdg = tempXdg()
    try {
      expect(readHubPointer()).toBeUndefined()
      mkdirSync(join(xdg, "opencode", "subplug"), { recursive: true })
      writeFileSync(hubPointerFile(), "not json")
      expect(readHubPointer()).toBeUndefined()
      writeFileSync(hubPointerFile(), JSON.stringify({ hubDir: "", at: 1 }))
      expect(readHubPointer()).toBeUndefined()
      writeFileSync(hubPointerFile(), JSON.stringify({ hubDir: "/tmp/hub-b" }))
      expect(readHubPointer()).toBeUndefined()
    } finally {
      rmSync(xdg, { recursive: true, force: true })
    }
  })
})
