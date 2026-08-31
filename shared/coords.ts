export type ViewportSize = { width: number; height: number };
export type CssBox = { width: number; height: number };

/**
 * Map a pointer event on a letterboxed canvas (object-fit: contain) back to
 * remote viewport coordinates. Uses the *server-owned* viewport size, never
 * a client-supplied remote size.
 */
export function mapCanvasToViewport(
  clientX: number,
  clientY: number,
  canvas: CssBox,
  viewport: ViewportSize,
  devicePixelRatio = 1,
): { x: number; y: number } | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;

  const cssW = canvas.width;
  const cssH = canvas.height;
  const scale = Math.min(cssW / viewport.width, cssH / viewport.height);
  const contentW = viewport.width * scale;
  const contentH = viewport.height * scale;
  const offsetX = (cssW - contentW) / 2;
  const offsetY = (cssH - contentH) / 2;

  const localX = clientX - offsetX;
  const localY = clientY - offsetY;
  if (localX < 0 || localY < 0 || localX > contentW || localY > contentH) {
    return null;
  }

  const x = Math.round(localX / scale);
  const y = Math.round(localY / scale);
  void devicePixelRatio;
  return {
    x: clamp(x, 0, viewport.width - 1),
    y: clamp(y, 0, viewport.height - 1),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
