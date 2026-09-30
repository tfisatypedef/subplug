import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupServer } from "../src/server/index.ts"
import { makeV2Context, type V2Fake } from "./v2-context.ts"

const PROJECT_ID = "lease-hook-project"
const cleanups: Array<() => void> = []

function pythonCommand(): string | undefined {
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"]
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" })
    if (!result.error) return candidate
  }
  return undefined
}

const python = pythonCommand()
const leaseTest = python ? test : test.skip

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()?.()
    } catch {
      // ignore cleanup failures
    }
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`)
  }
}

const STUB = `import json, os, sys
args = sys.argv[1:]
root = args[args.index("--root") + 1]
agent = args[args.index("--agent") + 1]
session = args[args.index("--session") + 1]
paths = [args[i + 1] for i, value in enumerate(args) if value == "--path"]
with open(os.path.join(root, "lease-calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"agent": agent, "session": session, "paths": paths}) + "\\n")
if os.path.exists(os.path.join(root, "lease-deny")):
    print("nothing locked: leased: " + paths[0] + " is leased by other@host/ses_other")
    sys.exit(1)
print("locked " + " ".join(paths) + " as " + agent)
`

function seedRepo(withCoordination: boolean): string {
  const repo = tempDir("repo-")
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "Harness Agent"])
  git(repo, ["config", "user.email", "harness@testhost"])
  writeFileSync(join(repo, "README.md"), "# repo\n")
  if (withCoordination) {
    mkdirSync(join(repo, "coordination", "claims"), { recursive: true })
    mkdirSync(join(repo, "tools"), { recursive: true })
    writeFileSync(join(repo, "tools", "coord.py"), STUB)
  }
  return repo
}

function leaseCalls(repo: string): Array<{ agent: string; session: string; paths: string[] }> {
  const raw = readFileSync(join(repo, "lease-calls.jsonl"), "utf8")
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { agent: string; session: string; paths: string[] })
}

async function startPlugin(repo: string, stateDir: string): Promise<V2Fake> {
  const fake = makeV2Context({ storageDir: stateDir }, repo, PROJECT_ID)
  const stop = await setupServer(fake.ctx)
  cleanups.push(stop)
  return fake
}

describe("v2 server lease enforcement", () => {
  leaseTest("denies an edit when another session holds the lease", async () => {
    const repo = seedRepo(true)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)
    writeFileSync(join(repo, "lease-deny"), "1\n")

    await expect(
      fake.runToolBefore({ tool: "edit", sessionID: "ses_edit000000001", input: { filePath: "src/app.py" } }),
    ).rejects.toThrow("is leased by other@host")

    const calls = leaseCalls(repo)
    expect(calls.length).toBe(1)
    expect(calls[0]?.session).toBe("ses_edit000000001")
    expect(calls[0]?.agent).toContain("ses_edit000000001")
    expect(calls[0]?.paths).toEqual(["src/app.py"])
  })

  leaseTest("allows a write after acquiring the lease", async () => {
    const repo = seedRepo(true)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)

    await fake.runToolBefore({ tool: "write", sessionID: "ses_write00000001", input: { filePath: "src/new.py", content: "x" } })

    const calls = leaseCalls(repo)
    expect(calls.length).toBe(1)
    expect(calls[0]?.paths).toEqual(["src/new.py"])
  })

  leaseTest("leases apply_patch add, move, and delete paths", async () => {
    const repo = seedRepo(true)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)

    await fake.runToolBefore({
      tool: "apply_patch",
      sessionID: "ses_patch00000001",
      input: {
        patchText: [
          "*** Begin Patch",
          "*** Add File: src/new.py",
          "*** Update File: src/app.py",
          "*** Move to: src/moved.py",
          "*** Delete File: src/old.py",
          "*** End Patch",
        ].join("\n"),
      },
    })

    const calls = leaseCalls(repo)
    expect(calls.length).toBe(1)
    expect(calls[0]?.paths).toEqual(["src/new.py", "src/app.py", "src/moved.py", "src/old.py"])
  })

  test("skips enforcement outside coordination-enabled repositories", async () => {
    const repo = seedRepo(false)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)

    await fake.runToolBefore({ tool: "edit", sessionID: "ses_plain00000001", input: { filePath: "src/app.py" } })

    expect(() => leaseCalls(repo)).toThrow()
  })

  test("does not lease bash tool calls", async () => {
    const repo = seedRepo(true)
    const stateDir = tempDir("state-")
    const fake = await startPlugin(repo, stateDir)

    await fake.runToolBefore({ tool: "bash", sessionID: "ses_bash000000001", input: { command: "ls -la" } })

    expect(() => leaseCalls(repo)).toThrow()
  })
})
