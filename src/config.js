export const config = {
  camera: {
    width: 1280,
    height: 720,
    facingMode: "user",
  },
  hand: {
    numHands: 1,
    // iPad 前面カメラの斜め・近距離でも拾いやすく、少し緩めにする
    minHandDetectionConfidence: 0.4,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  },
  estimation: {
    mode: "C",
    L: 0.12,
    offset: { x: 0, y: 0 },
  },
  smoothing: {
    mode: "ema",
    emaAlpha: 0.3,
    oneEuro: {
      minCutoff: 1.0,
      beta: 0.007,
      dCutoff: 1.0,
    },
  },
  drawing: {
    color: "#1c1914",
    lineWidth: 3,
    cursorColor: "#0f6b4c",
    guideColor: "rgba(28, 25, 20, 0.18)",
  },
  guide: {
    mode: "horizontal",
  },
  mediapipe: {
    wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm",
    model:
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  },
};

export const HAND_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
