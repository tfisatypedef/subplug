import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pickOpencodeBin, resolveOpencodeBin } from "../scripts/opencode-bin.ts"

describe("pickOpencodeBin", () => {
  test("returns a POSIX shim as-is", () => {
    expect(pickOpencodeBin(["/usr/local/bin/opencode2"], "linux")).toBe("/usr/local/bin/opencode2")
  })

  test("prefers a real .exe on Windows", () => {
    const candidates = ["C:\\bin\\opencode2", "C:\\bin\\opencode2.exe", "C:\\bin\\opencode2.cmd"]
    expect(pickOpencodeBin(candidates, "win32")).toBe("C:\\bin\\opencode2.exe")
  })

  test("derives the npm exe for an extensionless Windows shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "subplug-bin-"))
    try {
      const exe = join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
      mkdirSync(dirname(exe), { recursive: true })
      writeFileSync(exe, "")
      expect(pickOpencodeBin([join(dir, "opencode2"), join(dir, "opencode2.cmd")], "win32")).toBe(exe)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skips Windows candidates whose npm exe is missing", () => {
    expect(pickOpencodeBin(["C:\\nope\\opencode2", "C:\\nope\\opencode2.cmd"], "win32")).toBeUndefined()
  })

  test("returns undefined for no candidates", () => {
    expect(pickOpencodeBin([], "linux")).toBeUndefined()
  })
})

describe("resolveOpencodeBin", () => {
  test("honors OPENCODE_BIN", () => {
    const previous = process.env.OPENCODE_BIN
    process.env.OPENCODE_BIN = "C:\\custom\\opencode.exe"
    try {
      expect(resolveOpencodeBin()).toBe("C:\\custom\\opencode.exe")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BIN
      else process.env.OPENCODE_BIN = previous
    }
  })
})
