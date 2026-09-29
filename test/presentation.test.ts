import { describe, expect, test } from "bun:test"
import { createMarquee, marqueeStep, skinForTheme, type MarqueeTarget, type ThemeLike } from "../src/tui/presentation.ts"

describe("marquee", () => {
  test("ping-pongs between the ends", () => {
    expect(marqueeStep(4, 10, 1)).toEqual({ offset: 5, direction: 1 })
    expect(marqueeStep(10, 10, 1)).toEqual({ offset: 10, direction: -1 })
    expect(marqueeStep(10, 10, -1)).toEqual({ offset: 9, direction: -1 })
    expect(marqueeStep(0, 10, -1)).toEqual({ offset: 0, direction: 1 })
  })

  test("stays put when there is nothing to scroll", () => {
    expect(marqueeStep(3, 0, 1)).toEqual({ offset: 0, direction: 1 })
    expect(marqueeStep(3, -2, 1)).toEqual({ offset: 0, direction: 1 })
  })

  test("advances the target and resets on stop", async () => {
    const target: MarqueeTarget = { width: 10, scrollWidth: 14, scrollX: 0 }
    const marquee = createMarquee(() => target, { intervalMs: 5 })
    expect(marquee.active).toBe(false)
    marquee.start()
    expect(marquee.active).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(target.scrollX).toBeGreaterThan(0)
    marquee.stop()
    expect(marquee.active).toBe(false)
    expect(target.scrollX).toBe(0)
  })

  test("maps v2 theme tokens onto the skin", () => {
    const theme: ThemeLike = {
      text: {
        base: "text",
        muted: "muted",
        action: { primary: { base: "accent" }, secondary: { base: "secondary" } },
        feedback: {
          error: { base: "error" },
          warning: { base: "warning" },
          success: { base: "success" },
          info: { base: "info" },
        },
      },
      background: { base: "panel", raised: { base: "selection" } },
      border: { base: "border" },
    }
    expect(skinForTheme(theme)).toEqual({
      panel: "panel",
      border: "border",
      text: "text",
      muted: "muted",
      accent: "accent",
      error: "error",
      warning: "warning",
      success: "success",
      selection: "selection",
      secondary: "secondary",
    })
  })

  test("tolerates a missing target and a no-op width", async () => {
    const missing = createMarquee(() => undefined, { intervalMs: 5 })
    missing.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    missing.stop()
    const target: MarqueeTarget = { width: 40, scrollWidth: 40, scrollX: 0 }
    const marquee = createMarquee(() => target, { intervalMs: 5 })
    marquee.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(target.scrollX).toBe(0)
    marquee.stop()
  })
})
