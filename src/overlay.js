import { HAND_CONNECTIONS } from "./config.js";
import { toOverlayCanvas } from "./coordinateMapper.js";

export function drawHandOverlay(canvas, landmarks, tipNorm, videoWidth, videoHeight) {
  const ctx = canvas.getContext("2d");
  if (canvas.width !== videoWidth || canvas.height !== videoHeight) {
    canvas.width = videoWidth;
    canvas.height = videoHeight;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks) return;

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(15, 107, 76, 0.85)";
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = toOverlayCanvas(landmarks[a], canvas.width, canvas.height);
    const pb = toOverlayCanvas(landmarks[b], canvas.width, canvas.height);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255, 250, 242, 0.95)";
  for (const lm of landmarks) {
    const p = toOverlayCanvas(lm, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (tipNorm) {
    const tip = toOverlayCanvas(tipNorm, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.fillStyle = "#ffb703";
    ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function clearOverlay(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
