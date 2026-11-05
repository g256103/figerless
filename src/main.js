import { config } from "./config.js";
import { startCamera, stopCamera } from "./camera.js";
import { createHandTracker } from "./handTracker.js";
import { estimatePenTip, estimateGripScore } from "./penTipEstimator.js";
import { PointSmoother } from "./smoother.js";
import { toDrawCanvas } from "./coordinateMapper.js";
import { DrawingEngine } from "./drawingEngine.js";
import { drawHandOverlay, clearOverlay } from "./overlay.js";

const els = {
  video: document.getElementById("webcam"),
  overlay: document.getElementById("overlay"),
  drawCanvas: document.getElementById("drawCanvas"),
  btnStartCamera: document.getElementById("btnStartCamera"),
  btnCalibrate: document.getElementById("btnCalibrate"),
  btnToggleDraw: document.getElementById("btnToggleDraw"),
  btnClear: document.getElementById("btnClear"),
  estimationMode: document.getElementById("estimationMode"),
  smoothingMode: document.getElementById("smoothingMode"),
  guideMode: document.getElementById("guideMode"),
  penLength: document.getElementById("penLength"),
  penLengthValue: document.getElementById("penLengthValue"),
  emaAlpha: document.getElementById("emaAlpha"),
  emaAlphaValue: document.getElementById("emaAlphaValue"),
  message: document.getElementById("message"),
  metrics: document.getElementById("metrics"),
  cameraStatus: document.getElementById("cameraStatus"),
  handStatus: document.getElementById("handStatus"),
  drawStatus: document.getElementById("drawStatus"),
};

const state = {
  stream: null,
  tracker: null,
  running: false,
  drawingEnabled: false,
  strokeActive: false,
  calibrating: false,
  lastLandmarks: null,
  lastRawTip: null,
  lastSmoothTip: null,
  lastScore: 0,
  lastGrip: 0,
  frames: 0,
  fps: 0,
  lastFpsAt: performance.now(),
  rafId: 0,
};

const smoother = new PointSmoother();
smoother.setMode(config.smoothing.mode);
smoother.setEmaAlpha(config.smoothing.emaAlpha);
smoother.setOneEuro(config.smoothing.oneEuro);

const drawing = new DrawingEngine(els.drawCanvas, {
  color: config.drawing.color,
  lineWidth: config.drawing.lineWidth,
  cursorColor: config.drawing.cursorColor,
  guideColor: config.drawing.guideColor,
});
drawing.setGuideMode(config.guide.mode);

function setMessage(text) {
  els.message.textContent = text;
}

function setPill(el, text, on) {
  el.textContent = text;
  el.classList.toggle("on", Boolean(on));
}

function syncCanvasSize() {
  const rect = els.drawCanvas.parentElement.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  drawing.resize(width, height);
}

function enableControls(cameraOn) {
  els.btnCalibrate.disabled = !cameraOn;
  els.btnToggleDraw.disabled = !cameraOn;
  els.btnClear.disabled = !cameraOn;
}

async function onStartCamera() {
  try {
    setMessage("カメラと MediaPipe モデルを読み込み中…");
    els.btnStartCamera.disabled = true;

    state.stream = await startCamera(els.video, config.camera);
    state.tracker = await createHandTracker(config.mediapipe, config.hand);

    syncCanvasSize();
    state.running = true;
    setPill(els.cameraStatus, "カメラ: ON", true);
    enableControls(true);
    setMessage(
      "手が映ったら緑の骨格と黄色い仮想ペン先が出ます。画面に置かず、カメラの前でペン握り形を見せてから描画開始してください。",
    );
    els.btnStartCamera.textContent = "カメラ再起動";
    loop();
  } catch (err) {
    console.error(err);
    setMessage(`カメラ起動に失敗しました: ${err.message || err}`);
    els.btnStartCamera.disabled = false;
    setPill(els.cameraStatus, "カメラ: エラー", false);
  } finally {
    els.btnStartCamera.disabled = false;
  }
}

function onToggleDraw() {
  state.drawingEnabled = !state.drawingEnabled;
  if (!state.drawingEnabled) {
    state.strokeActive = false;
    drawing.endStroke();
  }
  els.btnToggleDraw.textContent = state.drawingEnabled ? "描画停止" : "描画開始";
  els.btnToggleDraw.classList.toggle("active", state.drawingEnabled);
  setPill(els.drawStatus, state.drawingEnabled ? "描画: ON" : "描画: OFF", state.drawingEnabled);
  setMessage(
    state.drawingEnabled
      ? "描画中。ペン握り形を維持して手首・手全体を動かしてください。"
      : "描画を停止しました。",
  );
}

function onClear() {
  drawing.clear();
  setMessage("線を消去しました。");
}

function onCalibrate() {
  if (!state.running) return;

  const target = {
    x: drawing.canvas.width * 0.5,
    y: drawing.canvas.height * 0.5,
  };

  if (!state.calibrating) {
    state.calibrating = true;
    state.drawingEnabled = false;
    state.strokeActive = false;
    drawing.endStroke();
    els.btnToggleDraw.textContent = "描画開始";
    els.btnToggleDraw.classList.remove("active");
    setPill(els.drawStatus, "描画: OFF", false);
    drawing.setCalibrationTarget(target);
    els.btnCalibrate.textContent = "この位置で確定";
    setMessage(
      "緑の点（仮想ペン先）を中央の十字に重ねて、もう一度ボタンを押して確定してください。",
    );
    return;
  }

  if (!state.lastRawTip) {
    setMessage("手が検出されていません。手を映してから再度確定してください。");
    return;
  }

  const desiredNorm = {
    x: 1 - target.x / drawing.canvas.width,
    y: target.y / drawing.canvas.height,
  };
  const currentWithoutOffset = {
    x: state.lastRawTip.x - config.estimation.offset.x,
    y: state.lastRawTip.y - config.estimation.offset.y,
  };
  config.estimation.offset = {
    x: desiredNorm.x - currentWithoutOffset.x,
    y: desiredNorm.y - currentWithoutOffset.y,
  };

  state.calibrating = false;
  drawing.setCalibrationTarget(null);
  els.btnCalibrate.textContent = "キャリブ（十字合わせ）";
  setMessage(
    `キャリブ完了。offset=(${config.estimation.offset.x.toFixed(3)}, ${config.estimation.offset.y.toFixed(3)})`,
  );
}

function updateMetrics() {
  const tip = state.lastSmoothTip;
  const tipText = tip
    ? `(${tip.x.toFixed(3)}, ${tip.y.toFixed(3)})`
    : "—";
  els.metrics.textContent =
    `Pen: ${tipText} | grip: ${state.lastGrip.toFixed(2)} | fps: ${state.fps} | score: ${state.lastScore.toFixed(2)} | mode: ${config.estimation.mode}`;
}

function loop() {
  if (!state.running) return;

  const now = performance.now();
  state.frames += 1;
  if (now - state.lastFpsAt >= 1000) {
    state.fps = state.frames;
    state.frames = 0;
    state.lastFpsAt = now;
  }

  const result = state.tracker?.detect(els.video, now);

  // null = same video frame (keep previous). object = new inference result.
  if (result) {
    if (result.landmarks?.length) {
      const landmarks = result.landmarks[0];
      const score = result.handednesses?.[0]?.[0]?.score || 1;

      state.lastLandmarks = landmarks;
      state.lastScore = score;
      state.lastGrip = estimateGripScore(landmarks);
      setPill(els.handStatus, "手: 検出中", true);

      const estimated = estimatePenTip(config.estimation.mode, landmarks, {
        L: config.estimation.L,
        offset: config.estimation.offset,
      });

      if (estimated) {
        state.lastRawTip = { x: estimated.x, y: estimated.y };
        const smooth = smoother.update(state.lastRawTip, now);
        state.lastSmoothTip = smooth;

        const videoW = els.video.videoWidth || 1280;
        const videoH = els.video.videoHeight || 720;
        drawHandOverlay(els.overlay, landmarks, smooth, videoW, videoH);

        const canvasPoint = toDrawCanvas(
          smooth,
          drawing.canvas.width,
          drawing.canvas.height,
          true,
        );
        drawing.setCursor(canvasPoint);

        if (state.drawingEnabled && canvasPoint) {
          if (!state.strokeActive) {
            drawing.beginStroke(canvasPoint);
            state.strokeActive = true;
          } else {
            drawing.continueStroke(canvasPoint);
          }
        }
      }
    } else {
      setPill(els.handStatus, "手: 未検出", false);
      state.lastLandmarks = null;
      state.lastRawTip = null;
      state.lastSmoothTip = null;
      state.lastGrip = 0;
      state.lastScore = 0;
      clearerFrame();

      if (state.strokeActive) {
        drawing.endStroke();
        state.strokeActive = false;
      }
      drawing.setCursor(null);
      smoother.reset();
    }
  }

  updateMetrics();
  state.rafId = requestAnimationFrame(loop);
}

function clearerFrame() {
  const videoW = els.video.videoWidth || els.overlay.width || 640;
  const videoH = els.video.videoHeight || els.overlay.height || 480;
  if (els.overlay.width !== videoW || els.overlay.height !== videoH) {
    els.overlay.width = videoW;
    els.overlay.height = videoH;
  }
  clearOverlay(els.overlay);
}

// UI bindings
els.btnStartCamera.addEventListener("click", onStartCamera);
els.btnToggleDraw.addEventListener("click", onToggleDraw);
els.btnClear.addEventListener("click", onClear);
els.btnCalibrate.addEventListener("click", onCalibrate);

els.estimationMode.addEventListener("change", (e) => {
  config.estimation.mode = e.target.value;
  smoother.reset();
  setMessage(`推定方式を ${config.estimation.mode} に切り替えました。`);
});

els.smoothingMode.addEventListener("change", (e) => {
  config.smoothing.mode = e.target.value;
  smoother.setMode(config.smoothing.mode);
  setMessage(`平滑化を ${config.smoothing.mode} に切り替えました。`);
});

els.guideMode.addEventListener("change", (e) => {
  config.guide.mode = e.target.value;
  drawing.setGuideMode(config.guide.mode);
});

els.penLength.addEventListener("input", (e) => {
  config.estimation.L = Number(e.target.value);
  els.penLengthValue.textContent = config.estimation.L.toFixed(2);
});

els.emaAlpha.addEventListener("input", (e) => {
  config.smoothing.emaAlpha = Number(e.target.value);
  els.emaAlphaValue.textContent = config.smoothing.emaAlpha.toFixed(2);
  smoother.setEmaAlpha(config.smoothing.emaAlpha);
});

window.addEventListener("resize", syncCanvasSize);
syncCanvasSize();

window.addEventListener("beforeunload", () => {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  stopCamera(els.video, state.stream);
  state.tracker?.close();
});
