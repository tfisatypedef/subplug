import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  activeClaims,
  buildRegistryState,
  claimCovers,
  conflictingClaims,
  coverageErrors,
  foldEvents,
  isExempt,
  isPlanningPath,
  readAdoptionPaths,
  readEvents,
} from "../src/coord/claims.ts"
import { globMatch } from "../src/coord/glob.ts"
import type { RegistryEvent } from "../src/coord/claims.ts"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "subplug-coord-"))
}

function claimEvent(overrides: Partial<RegistryEvent> & { claim_id: string; agent: string }): RegistryEvent {
  return {
    event_id: `e-${overrides.claim_id}-claim`,
    kind: "claim",
    issued: "2026-09-27T10:00:00Z",
    expires: "2026-09-27T18:00:00Z",
    scopes: { patterns: [], files: [], docs: [], evidence: [], baton: null },
    ...overrides,
  }
}

describe("glob", () => {
  test("matches like python fnmatch including separators", () => {
    expect(globMatch("tools/coord.py", "tools/**")).toBe(true)
    expect(globMatch("tools/nested/plant.py", "tools/*.py")).toBe(true)
    expect(globMatch("src/app.py", "tools/*.py")).toBe(false)
    expect(globMatch("plans/workstreams/work-0001.md", "plans/workstreams/*.md")).toBe(true)
    expect(globMatch("docs/readme.md", "*.md")).toBe(true)
    expect(globMatch("docs/readme.md", "readme.md")).toBe(false)
  })
})

describe("paths", () => {
  test("exempt and planning checks mirror coord.py", () => {
    expect(isExempt("coordination/claims/a.jsonl")).toBe(true)
    expect(isExempt("src/__pycache__/x.pyc")).toBe(true)
    expect(isExempt("README.md")).toBe(true)
    expect(isExempt("src/app.py")).toBe(false)
    expect(isPlanningPath("plans/README.md")).toBe(true)
    expect(isPlanningPath("plans/workstreams/work-0001.md")).toBe(true)
    expect(isPlanningPath("plans/phases/phase-0001.md")).toBe(false)
  })

  test("adoption paths come from the plant lock plus fixed extras", () => {
    const dir = tempDir()
    try {
      mkdirSync(join(dir, "plans"), { recursive: true })
      writeFileSync(
        join(dir, "plans", ".plant-lock.json"),
        JSON.stringify({ files: { "PROTOCOL.md": "x", "templates/phase.md": "y" } }),
      )
      const paths = readAdoptionPaths(dir)
      expect(paths.has("plans/PROTOCOL.md")).toBe(true)
      expect(paths.has("plans/templates/phase.md")).toBe(true)
      expect(paths.has("tools/plant.py")).toBe(true)
      expect(paths.has("plans/.plant-lock.json")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("foldEvents", () => {
  test("projects claims, renews, releases and takeovers", () => {
    const events: RegistryEvent[] = [
      claimEvent({ claim_id: "claim-1", agent: "a@host" }),
      {
        event_id: "e-renew",
        kind: "renew",
        agent: "a@host",
        claim_id: "claim-1",
        issued: "2026-09-27T11:00:00Z",
        expires: "2026-09-28T02:00:00Z",
      },
      claimEvent({ claim_id: "claim-2", agent: "b@host" }),
      {
        event_id: "e-release",
        kind: "release",
        agent: "a@host",
        claim_id: "claim-1",
        issued: "2026-09-27T12:00:00Z",
      },
    ]
    const folded = foldEvents(events)
    expect(folded.errors).toEqual([])
    expect(folded.claims.get("claim-1")?.status).toBe("released")
    expect(folded.claims.get("claim-2")?.status).toBe("active")
  })

  test("lifecycle from the wrong agent is an error", () => {
    const folded = foldEvents([
      claimEvent({ claim_id: "claim-1", agent: "a@host" }),
      {
        event_id: "e-release",
        kind: "release",
        agent: "b@host",
        claim_id: "claim-1",
        issued: "2026-09-27T12:00:00Z",
      },
    ])
    expect(folded.errors.length).toBe(1)
    expect(folded.claims.get("claim-1")?.status).toBe("active")
  })
})

describe("conflicts", () => {
  const now = Date.parse("2026-09-27T12:00:00Z")

  test("shared files and baton collisions are reported", () => {
    const folded = foldEvents([
      claimEvent({
        claim_id: "claim-a",
        agent: "a@host",
        scopes: { patterns: [], files: ["src/app.py"], docs: [], evidence: [], baton: "verify" },
      }),
      claimEvent({
        claim_id: "claim-b",
        agent: "b@host",
        scopes: { patterns: [], files: ["src/app.py"], docs: [], evidence: [], baton: "verify" },
      }),
    ])
    const conflicts = conflictingClaims(folded.claims, now, new Set())
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]?.reason).toContain("baton verify")
  })

  test("planning baton conflicts with planning files", () => {
    const folded = foldEvents([
      claimEvent({
        claim_id: "claim-a",
        agent: "a@host",
        scopes: { patterns: [], files: [], docs: [], evidence: [], baton: "planning" },
      }),
      claimEvent({
        claim_id: "claim-b",
        agent: "b@host",
        scopes: { patterns: [], files: ["plans/README.md"], docs: [], evidence: [], baton: null },
      }),
    ])
    const conflicts = conflictingClaims(folded.claims, now, new Set())
    expect(conflicts.some((conflict) => conflict.reason.includes("planning baton"))).toBe(true)
  })

  test("expired claims never block", () => {
    const folded = foldEvents([
      claimEvent({ claim_id: "claim-a", agent: "a@host", expires: "2026-09-27T11:00:00Z" }),
    ])
    expect(activeClaims(folded.claims, now)).toEqual([])
  })
})

describe("claimCovers", () => {
  test("files, patterns and evidence prefixes", () => {
    const folded = foldEvents([
      claimEvent({
        claim_id: "claim-a",
        agent: "a@host",
        scopes: {
          patterns: ["tests/tools/**"],
          files: ["src/app.py"],
          docs: [],
          evidence: ["evidence/phase-0003"],
          baton: null,
        },
      }),
    ])
    const claim = folded.claims.get("claim-a")!
    expect(claimCovers(claim, "src/app.py", new Set())).toBe(true)
    expect(claimCovers(claim, "tests/tools/test_coord.py", new Set())).toBe(true)
    expect(claimCovers(claim, "evidence/phase-0003/report.json", new Set())).toBe(true)
    expect(claimCovers(claim, "src/other.py", new Set())).toBe(false)
  })
})

describe("coverageErrors", () => {
  const now = Date.parse("2026-09-27T12:00:00Z")

  test("reports uncovered paths, owner hints, and missing batons", () => {
    const folded = foldEvents([
      claimEvent({
        claim_id: "claim-a",
        agent: "a@host",
        scopes: { patterns: ["src/**"], files: ["src/app.py"], docs: [], evidence: [], baton: "verify" },
      }),
    ])
    const claims = [...folded.claims.values()]
    const adoption = new Set(["tools/plant.py"])

    expect(coverageErrors("a@host", claims, ["src/app.py"], adoption, now)).toEqual([])

    const foreign = coverageErrors("b@host", claims, ["src/app.py"], adoption, now)
    expect(foreign.length).toBe(1)
    expect(foreign[0]).toContain("no active claim of b@host")
    expect(foreign[0]).toContain("covered by a@host")

    const planning = coverageErrors("a@host", claims, ["plans/README.md"], adoption, now)
    expect(planning.some((error) => error.includes("planning baton"))).toBe(true)

    const planted = coverageErrors("a@host", claims, ["tools/plant.py"], adoption, now)
    expect(planted.some((error) => error.includes("adoption baton"))).toBe(true)

    expect(coverageErrors("a@host", claims, ["README.md"], adoption, now)).toEqual([])
  })
})

describe("readEvents", () => {
  test("reads valid events, dedupes by id and reports bad lines", () => {
    const dir = tempDir()
    try {
      mkdirSync(dir, { recursive: true })
      const valid = claimEvent({ claim_id: "claim-1", agent: "a@host" })
      writeFileSync(
        join(dir, "a.jsonl"),
        `${JSON.stringify(valid)}\n{ not json\n${JSON.stringify(valid)}\n${JSON.stringify({
          event_id: "x",
          kind: "nope",
          agent: "a",
          issued: "2026-09-27T10:00:00Z",
        })}\n`,
      )
      const { events, errors } = readEvents(dir)
      expect(events.length).toBe(1)
      expect(errors.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("buildRegistryState", () => {
  test("end to end over a coordination directory", () => {
    const repo = tempDir()
    try {
      const claims = join(repo, "coordination", "claims")
      mkdirSync(claims, { recursive: true })
      const lines = [
        claimEvent({
          claim_id: "claim-1",
          agent: "a@host",
          issued: "2026-09-27T09:00:00Z",
          expires: "2026-09-28T09:00:00Z",
          scopes: { patterns: ["tools/coord.py"], files: ["tools/coord.py"], docs: [], evidence: [], baton: null },
        }),
        {
          event_id: "verify-1",
          kind: "verification",
          agent: "a@host",
          issued: "2026-09-27T09:30:00Z",
          commit: "abcdef1234567890",
          result: "passed",
          scope: "full",
          commands: ["uv run pytest"],
        },
      ]
      writeFileSync(join(claims, "a.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
      writeFileSync(join(repo, "AGENTS.md"), "")
      const state = buildRegistryState(repo, Date.parse("2026-09-27T12:00:00Z"))
      expect(state.errors).toEqual([])
      expect(state.claims.length).toBe(1)
      expect(state.lastPassingVerification?.commit).toBe("abcdef1234567890")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
