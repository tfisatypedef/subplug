import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireLeases, parsePatchPaths, relativeLeasePath, toolLeasePaths } from "../src/coord/leases.ts"

describe("parsePatchPaths", () => {
  test("collects add, update, delete, and move targets", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.py",
      "*** Update File: src/app.py",
      "*** Move to: src/renamed.py",
      "*** Delete File: src/old.py",
      "*** End Patch",
    ].join("\n")

    expect(parsePatchPaths(patch)).toEqual(["src/new.py", "src/app.py", "src/renamed.py", "src/old.py"])
  })

  test("handles CRLF and ignores hunk content", () => {
    const patch = "*** Begin Patch\r\n*** Update File: src/app.py\r\n@@\r\n-old\r\n+new\r\n"

    expect(parsePatchPaths(patch)).toEqual(["src/app.py"])
  })

  test("dedupes repeated paths", () => {
    const patch = "*** Update File: src/app.py\n*** Delete File: src/app.py\n"

    expect(parsePatchPaths(patch)).toEqual(["src/app.py"])
  })
})

describe("toolLeasePaths", () => {
  test("reads filePath for edit and write", () => {
    expect(toolLeasePaths("edit", { filePath: "src/app.py" })).toEqual(["src/app.py"])
    expect(toolLeasePaths("write", { filePath: "/repo/src/app.py", content: "x" })).toEqual(["/repo/src/app.py"])
    expect(toolLeasePaths("edit", {})).toEqual([])
  })

  test("parses apply_patch text including moves", () => {
    const args = { patchText: "*** Update File: a.py\n*** Move to: b.py\n*** Delete File: c.py\n" }

    expect(toolLeasePaths("apply_patch", args)).toEqual(["a.py", "b.py", "c.py"])
  })

  test("ignores other tools", () => {
    expect(toolLeasePaths("bash", { command: "rm -rf" })).toEqual([])
  })
})

describe("relativeLeasePath", () => {
  test("keeps paths inside the repository and drops escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "subplug-lease-"))
    try {
      expect(relativeLeasePath(root, "src/app.py")).toBe("src/app.py")
      expect(relativeLeasePath(root, join(root, "src", "app.py"))).toBe("src/app.py")
      expect(relativeLeasePath(root, "../outside.py")).toBeUndefined()
      expect(relativeLeasePath(root, join(root, "..", "outside.py"))).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("acquireLeases", () => {
  test("skips repositories without tools/coord.py", () => {
    const root = mkdtempSync(join(tmpdir(), "subplug-lease-"))
    try {
      const outcome = acquireLeases({
        repoRoot: root,
        holder: "a@host/ses_1",
        sessionID: "ses_1",
        pid: 1,
        paths: ["src/app.py"],
      })

      expect(outcome).toEqual({ status: "skipped", reason: "no tools/coord.py" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
