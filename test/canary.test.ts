import { describe, expect, test } from "bun:test"
import { atLeast, isDevHost, parseVersion, satisfiesRange } from "../scripts/canary.ts"

describe("canary version checks", () => {
  test("parses semver prefixes, host banners, and dev builds", () => {
    expect(parseVersion("1.18.33")).toEqual({ major: 1, minor: 18, patch: 33 })
    expect(parseVersion(" 1.19.0\n")).toEqual({ major: 1, minor: 19, patch: 0 })
    expect(parseVersion("2.0.19")).toEqual({ major: 2, minor: 0, patch: 19 })
    expect(parseVersion("v2.0.19")).toEqual({ major: 2, minor: 0, patch: 19 })
    expect(parseVersion("opencode v0.0.0-dev-20288")).toEqual({ major: 0, minor: 0, patch: 0 })
    expect(parseVersion("garbage")).toBeUndefined()
  })

  test("recognizes dev host builds", () => {
    expect(isDevHost("opencode v0.0.0-dev-20288")).toBe(true)
    expect(isDevHost("v0.0.0-dev-1")).toBe(true)
    expect(isDevHost("2.0.19")).toBe(false)
    expect(isDevHost("1.18.33")).toBe(false)
  })

  test("atLeast compares numeric components", () => {
    const minimum = { major: 2, minor: 0, patch: 19 }
    expect(atLeast({ major: 2, minor: 0, patch: 20 }, minimum)).toBe(true)
    expect(atLeast({ major: 2, minor: 0, patch: 18 }, minimum)).toBe(false)
    expect(atLeast({ major: 2, minor: 1, patch: 0 }, minimum)).toBe(true)
    expect(atLeast({ major: 3, minor: 0, patch: 0 }, minimum)).toBe(true)
  })

  test("caret accepts the v2 line and rejects older majors", () => {
    const range = "^2.0.19"
    expect(satisfiesRange({ major: 2, minor: 0, patch: 19 }, range)).toBe(true)
    expect(satisfiesRange({ major: 2, minor: 3, patch: 0 }, range)).toBe(true)
    expect(satisfiesRange({ major: 2, minor: 0, patch: 18 }, range)).toBe(false)
    expect(satisfiesRange({ major: 1, minor: 18, patch: 33 }, range)).toBe(false)
    expect(satisfiesRange({ major: 3, minor: 0, patch: 0 }, range)).toBe(false)
  })
})
