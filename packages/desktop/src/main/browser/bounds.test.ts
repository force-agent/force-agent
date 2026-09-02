import { describe, expect, test } from "bun:test"
import { viewBounds } from "./bounds"

describe("viewBounds", () => {
  test("passes integer CSS pixels through at zoom 1", () => {
    expect(viewBounds({ x: 10, y: 20, width: 300, height: 200 }, 1)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })

  test("scales by the zoom factor", () => {
    expect(viewBounds({ x: 10, y: 20, width: 300, height: 200 }, 2)).toEqual({ x: 20, y: 40, width: 600, height: 400 })
  })

  test("rounds the origin down and the far edge up so no seam appears", () => {
    expect(viewBounds({ x: 10.6, y: 20.4, width: 300.2, height: 199.9 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 301,
      height: 201,
    })
  })

  test("clips a panel past the window edge instead of placing the view at a negative origin", () => {
    expect(viewBounds({ x: -10, y: -5, width: 100, height: 50 }, 1)).toEqual({ x: 0, y: 0, width: 90, height: 45 })
    expect(viewBounds({ x: -200, y: 0, width: 100, height: 50 }, 1)).toEqual({ x: 0, y: 0, width: 0, height: 50 })
  })

  test("treats a bogus zoom factor as 1 and never returns a negative size", () => {
    expect(viewBounds({ x: 5, y: 5, width: -10, height: 0 }, Number.NaN)).toEqual({ x: 5, y: 5, width: 0, height: 0 })
    expect(viewBounds({ x: 5, y: 5, width: 10, height: 10 }, 0)).toEqual({ x: 5, y: 5, width: 10, height: 10 })
  })
})
