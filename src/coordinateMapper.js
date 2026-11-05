/**
 * MediaPipe landmarks are normalized [0,1] in the video frame.
 * Video is mirrored with CSS scaleX(-1), and overlay canvas is also mirrored.
 * Drawing canvas is NOT mirrored — so we flip X when mapping to draw space
 * so that left/right matches what the user sees in the mirrored camera.
 */
export function toDrawCanvas(normPoint, canvasWidth, canvasHeight, mirrored = true) {
  if (!normPoint) return null;
  const xNorm = mirrored ? 1 - normPoint.x : normPoint.x;
  return {
    x: xNorm * canvasWidth,
    y: normPoint.y * canvasHeight,
  };
}

export function toOverlayCanvas(normPoint, canvasWidth, canvasHeight) {
  if (!normPoint) return null;
  // Overlay is CSS-mirrored with the video, so keep MediaPipe coords as-is.
  return {
    x: normPoint.x * canvasWidth,
    y: normPoint.y * canvasHeight,
  };
}
