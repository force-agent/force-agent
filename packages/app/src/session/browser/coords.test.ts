import { describe, expect, test } from "bun:test"
import { fitFrame, toPagePoint } from "./coords"

describe("browser canvas → page coordinates", () => {
  test("fitFrame letterboxes a wide frame inside a tall box", () => {
    expect(fitFrame({ width: 400, height: 400 }, { width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 75,
      width: 400,
      height: 250,
    })
    expect(fitFrame({ width: 0, height: 100 }, { width: 1280, height: 800 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
  })

  test("toPagePoint scales through the drawn rect and ignores the letterbox", () => {
    const fit = fitFrame({ width: 640, height: 500 }, { width: 1280, height: 800 })
    const header = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1 }
    expect(toPagePoint({ x: 0, y: fit.y }, fit, header)).toEqual({ x: 0, y: 0 })
    expect(toPagePoint({ x: 320, y: fit.y + 200 }, fit, header)).toEqual({ x: 640, y: 400 })
    expect(toPagePoint({ x: 640, y: fit.y + 400 }, fit, header)).toEqual({ x: 1280, y: 800 })
    expect(toPagePoint({ x: 10, y: 5 }, fit, header)).toBeUndefined()
  })

  test("toPagePoint divides by the pinch zoom factor", () => {
    const fit = { x: 0, y: 0, width: 1280, height: 800 }
    expect(toPagePoint({ x: 640, y: 400 }, fit, { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 2 })).toEqual({
      x: 320,
      y: 200,
    })
  })
})
