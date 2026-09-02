export type Size = { readonly width: number; readonly height: number }
export type Point = { readonly x: number; readonly y: number }

// Where a frame lands inside the canvas box when scaled to fit ("contain"), in canvas CSS px.
export type Fit = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export function fitFrame(box: Size, frame: Size): Fit {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0 }
  const scale = Math.min(box.width / frame.width, box.height / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height }
}

// Canvas CSS px → page viewport CSS px. `deviceWidth`/`deviceHeight` are the viewport the frame
// image covers; `pageScaleFactor` is pinch zoom, which CDP input coordinates do not include.
export function toPagePoint(
  point: Point,
  fit: Fit,
  header: { readonly deviceWidth: number; readonly deviceHeight: number; readonly pageScaleFactor: number },
): Point | undefined {
  if (fit.width <= 0 || fit.height <= 0) return undefined
  const fx = (point.x - fit.x) / fit.width
  const fy = (point.y - fit.y) / fit.height
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return undefined
  const scale = header.pageScaleFactor > 0 ? header.pageScaleFactor : 1
  return {
    x: Math.round((fx * header.deviceWidth) / scale),
    y: Math.round((fy * header.deviceHeight) / scale),
  }
}
