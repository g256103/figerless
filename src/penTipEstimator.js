function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(v, s) {
  return { x: v.x * s, y: v.y * s };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function normalize(v) {
  const n = Math.hypot(v.x, v.y);
  if (n < 1e-6) return null;
  return { x: v.x / n, y: v.y / n };
}

function average(points) {
  const n = points.length;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / n, y: y / n };
}

/** Higher score ≈ pen-holding pose (thumb+index(+middle) pinch, other fingers curled). */
export function estimateGripScore(landmarks) {
  if (!landmarks || landmarks.length < 21) return 0;

  const thumb = landmarks[4];
  const index = landmarks[8];
  const middle = landmarks[12];
  const indexMcp = landmarks[5];
  const middleMcp = landmarks[9];
  const ring = landmarks[16];
  const pinky = landmarks[20];

  const pinch = dist(thumb, index);
  const indexMiddle = dist(index, middle);
  const indexCurl = dist(index, indexMcp);
  const middleCurl = dist(middle, middleMcp);
  const ringFold = dist(ring, landmarks[13]);
  const pinkyFold = dist(pinky, landmarks[17]);

  let score = 0;
  // Pen grip: thumb near index tip, not fully open flat hand
  if (pinch > 0.015 && pinch < 0.14) score += 0.34;
  if (indexMiddle < 0.09) score += 0.22;
  if (indexCurl < 0.13) score += 0.14;
  if (middleCurl < 0.14) score += 0.14;
  if (ringFold < 0.11) score += 0.08;
  if (pinkyFold < 0.11) score += 0.08;

  return Math.max(0, Math.min(1, score));
}

/**
 * @returns {{ x:number, y:number, meta: object } | null}
 */
export function estimatePenTip(mode, landmarks, params) {
  if (!landmarks || landmarks.length < 21) return null;

  const wrist = landmarks[0];
  const thumb = landmarks[4];
  const index = landmarks[8];
  const middle = landmarks[12];
  const L = params.L ?? 0.12;
  const offset = params.offset ?? { x: 0, y: 0 };

  let tip = null;
  let G = null;
  let v = null;

  if (mode === "A") {
    tip = { x: index.x, y: index.y };
  } else if (mode === "B") {
    G = average([thumb, index]);
    tip = { ...G };
  } else if (mode === "C") {
    G = average([thumb, index]);
    v = normalize(sub(G, wrist));
    if (!v) return null;
    tip = add(G, scale(v, L));
  } else if (mode === "D") {
    G = average([thumb, index, middle]);
    v = normalize(sub(G, wrist));
    if (!v) return null;
    tip = add(G, scale(v, L));
  } else {
    G = average([thumb, index]);
    v = normalize(sub(G, wrist));
    if (!v) return null;
    tip = add(G, scale(v, L));
  }

  tip = add(tip, offset);

  return {
    x: tip.x,
    y: tip.y,
    meta: { G, v, mode },
  };
}
