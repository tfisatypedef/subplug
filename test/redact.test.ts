import { describe, expect, test } from "bun:test"
import { categorizeCommand, redactText, summarizeCommand } from "../src/shared/redact.ts"

describe("categorizeCommand", () => {
  test("recognizes git commit, push, coord, plant and test commands", () => {
    expect(categorizeCommand('git add tools/coord.py && git commit -m "coord update"')).toBe("git-commit")
    expect(categorizeCommand("git push origin main")).toBe("git-push")
    expect(categorizeCommand("python tools/coord.py claim --file src/app.py")).toBe("coord")
    expect(categorizeCommand("python tools/plant.py check plans")).toBe("plant")
    expect(categorizeCommand("uv run pytest -q")).toBe("test")
    expect(categorizeCommand("ls -la")).toBe("other")
  })
})

describe("summarizeCommand", () => {
  test("keeps only the first line and truncates", () => {
    const summary = summarizeCommand("git status --short\necho second")
    expect(summary).toBe("git status --short")
    expect(summarizeCommand("x".repeat(300)).length).toBe(140)
  })

  test("redacts obvious secrets", () => {
    const fakeGithubToken = `ghp_${"a".repeat(36)}`
    const fakeOpenAiKey = `sk-${"a".repeat(32)}`

    const summary = summarizeCommand(`GITHUB_TOKEN=${fakeGithubToken} git push`)
    expect(summary).not.toContain(fakeGithubToken)
    expect(summary).toContain("<redacted>")
    expect(summarizeCommand("curl https://user:supersecret@example.com/x")).toContain("<redacted>")
    expect(redactText(fakeOpenAiKey)).toContain("<redacted>")
  })
})
