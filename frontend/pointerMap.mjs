// Maps a pointer position in the browser window to a pixel of the device video.

/**
 * The canvas is drawn at some CSS size (`rect`) but holds `videoWidth` x `videoHeight`
 * device pixels. Each axis is scaled on its own, so the result is right at any window
 * size, zoom level or devicePixelRatio, and after a rotation changes the video size.
 * Positions outside the canvas (a drag that leaves it) are clamped to the nearest edge.
 *
 * @param {number} clientX pointer position in CSS pixels, relative to the viewport
 * @param {number} clientY
 * @param {{ left: number, top: number, width: number, height: number }} rect canvas.getBoundingClientRect()
 * @param {number} videoWidth canvas.width, in device pixels
 * @param {number} videoHeight canvas.height, in device pixels
 * @returns {{ x: number, y: number } | null} null while the canvas has no size
 */
export function clientToVideoPoint(clientX, clientY, rect, videoWidth, videoHeight) {
  if (rect.width <= 0 || rect.height <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
  const x = Math.floor(((clientX - rect.left) * videoWidth) / rect.width);
  const y = Math.floor(((clientY - rect.top) * videoHeight) / rect.height);
  return {
    x: Math.max(0, Math.min(videoWidth - 1, x)),
    y: Math.max(0, Math.min(videoHeight - 1, y)),
  };
}
