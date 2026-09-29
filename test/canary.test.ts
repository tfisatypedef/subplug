import { describe, expect, test } from "bun:test"
import { atLeast, parseVersion, satisfiesRange } from "../scripts/canary.ts"

describe("canary version checks", () => {
  test("parses semver prefixes and rejects noise", () => {
    expect(parseVersion("1.18.33")).toEqual({ major: 1, minor: 18, patch: 33 })
    expect(parseVersion(" 1.19.0\n")).toEqual({ major: 1, minor: 19, patch: 0 })
    expect(parseVersion("v1.19.0-beta")).toBeUndefined()
    expect(parseVersion("garbage")).toBeUndefined()
  })

  test("atLeast compares numeric components", () => {
    const minimum = { major: 1, minor: 18, patch: 32 }
    expect(atLeast({ major: 1, minor: 18, patch: 33 }, minimum)).toBe(true)
    expect(atLeast({ major: 1, minor: 18, patch: 31 }, minimum)).toBe(false)
    expect(atLeast({ major: 1, minor: 19, patch: 0 }, minimum)).toBe(true)
    expect(atLeast({ major: 2, minor: 0, patch: 0 }, minimum)).toBe(true)
  })

  test("caret accepts compatible hosts and rejects older or major bumps", () => {
    const range = "^1.18.32"
    expect(satisfiesRange({ major: 1, minor: 18, patch: 33 }, range)).toBe(true)
    expect(satisfiesRange({ major: 1, minor: 19, patch: 0 }, range)).toBe(true)
    expect(satisfiesRange({ major: 1, minor: 18, patch: 31 }, range)).toBe(false)
    expect(satisfiesRange({ major: 2, minor: 0, patch: 0 }, range)).toBe(false)
  })
})
