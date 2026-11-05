import { config } from "./config.js";
import { startCamera, stopCamera } from "./camera.js";
import { createHandTracker } from "./handTracker.js";
import { estimatePenTip, estimateGripScore } from "./penTipEstimator.js";
import { PointSmoother } from "./smoother.js";
import { toDrawCanvas } from "./coordinateMapper.js";
import { DrawingEngine } from "./drawingEngine.js";
import { drawHandOverlay, clearOverlay } from "./overlay.js";

const GRIP_DEFAULT = 0.55;

const els = {
  video: document.getElementById("webcam"),
  overlay: document.getElementById("overlay"),
  drawCanvas: document.getElementById("drawCanvas"),
  canvasWrap: document.getElementById("canvasWrap"),
  btnStartCamera: document.getElementById("btnStartCamera"),
  btnSetTip: document.getElementById("btnSetTip"),
  btnClear: document.getElementById("btnClear"),
  estimationMode: document.getElementById("estimationMode"),
  smoothingMode: document.getElementById("smoothingMode"),
  guideMode: document.getElementById("guideMode"),
  penLength: document.getElementById("penLength"),
  penLengthValue: document.getElementById("penLengthValue"),
  emaAlpha: document.getElementById("emaAlpha"),
  emaAlphaValue: document.getElementById("emaAlphaValue"),
  gripThreshold: document.getElementById("gripThreshold"),
  gripThresholdValue: document.getElementById("gripThresholdValue"),
  message: document.getElementById("message"),
  metrics: document.getElementById("metrics"),
  holdBanner: document.getElementById("holdBanner"),
  toast: document.getElementById("toast"),
  cameraStatus: document.getElementById("cameraStatus"),
  handStatus: document.getElementById("handStatus"),
  gripStatus: document.getElementById("gripStatus"),
  inkStatus: document.getElementById("inkStatus"),
  settingsModal: document.getElementById("settingsModal"),
  btnOpenSettings: document.getElementById("btnOpenSettings"),
  btnCloseSettings: document.getElementById("btnCloseSettings"),
  settingsBackdrop: document.getElementById("settingsBackdrop"),
};

let toastTimer = 0;

const state = {
  stream: null,
  tracker: null,
  running: false,
  tipCalibrated: false,
  awaitingTipTap: false,
  strokeActive: false,
  lastLandmarks: null,
  lastBaseTip: null, // estimated tip before user offset, in norm space
  lastSmoothTip: null,
  lastGrip: 0,
  gripping: false,
  inking: false,
  gripThreshold: GRIP_DEFAULT,
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
drawing.setContactDebug(null);

function setPill(el, text, on) {
  el.textContent = text;
  el.classList.toggle("on", Boolean(on));
}

function setMessage(text, { toast = false } = {}) {
  if (els.message) els.message.textContent = text;
  if (!toast || !els.toast) return;
  els.toast.hidden = false;
  els.toast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

function setBanner(text, ready = false) {
  els.holdBanner.textContent = text;
  els.holdBanner.classList.toggle("ready", ready);
  els.holdBanner.classList.remove("hidden");
}

function syncCanvasSize() {
  const rect = els.drawCanvas.parentElement.getBoundingClientRect();
  drawing.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
}

function openSettings() {
  els.settingsModal.hidden = false;
}

function closeSettings() {
  els.settingsModal.hidden = true;
  requestAnimationFrame(() => {
    syncCanvasSize();
    requestAnimationFrame(syncCanvasSize);
  });
}

function canvasPointFromEvent(e) {
  const rect = els.drawCanvas.getBoundingClientRect();
  const scaleX = els.drawCanvas.width / Math.max(rect.width, 1);
  const scaleY = els.drawCanvas.height / Math.max(rect.height, 1);
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

/** Convert canvas pixel → MediaPipe norm (mirrored mapping inverse). */
function canvasToNorm(point) {
  return {
    x: 1 - point.x / Math.max(els.drawCanvas.width, 1),
    y: point.y / Math.max(els.drawCanvas.height, 1),
  };
}

async function onStartCamera() {
  try {
    setMessage("カメラと手認識モデルを読み込み中…", { toast: true });
    els.btnStartCamera.disabled = true;

    if (state.running) {
      stopAll();
    }

    state.stream = await startCamera(els.video, config.camera);
    state.tracker = await createHandTracker(config.mediapipe, config.hand);
    syncCanvasSize();
    state.running = true;
    state.tipCalibrated = false;
    state.awaitingTipTap = false;
    config.estimation.offset = { x: 0, y: 0 };

    els.btnSetTip.disabled = false;
    els.btnClear.disabled = false;
    setPill(els.cameraStatus, "カメラ: ON", true);
    setBanner("ペン握り形で手を見せてから「ペン先を指定」");
    setMessage("手が検出されたら「ペン先を指定」→ キャンバスをタップ。握り形のときだけインクが出ます。");
    loop();
  } catch (err) {
    console.error(err);
    setMessage(`カメラ起動に失敗: ${err.message || err}`, { toast: true });
    setPill(els.cameraStatus, "カメラ: エラー", false);
  } finally {
    els.btnStartCamera.disabled = false;
    els.btnStartCamera.textContent = state.running ? "カメラ再起動" : "カメラ開始";
  }
}

function stopAll() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  stopCamera(els.video, state.stream);
  state.stream = null;
  state.tracker?.close();
  state.tracker = null;
  state.strokeActive = false;
  state.inking = false;
  clearOverlay(els.overlay);
}

function onSetTip() {
  if (!state.running) return;
  if (!state.lastBaseTip) {
    setMessage("先にペン握り形の手をカメラに映してください。", { toast: true });
    return;
  }
  state.awaitingTipTap = true;
  drawing.setCalibrationTarget({
    x: drawing.canvas.width * 0.5,
    y: drawing.canvas.height * 0.5,
  });
  setBanner("想定するペン先の位置をキャンバスでタップ", true);
  setMessage("いまの手の位置を基準に、ペン先だと思う場所をタップしてください。", { toast: true });
}

function applyTipFromCanvasPoint(canvasPoint) {
  if (!state.lastBaseTip) {
    setMessage("手が検出されていません。", { toast: true });
    return;
  }
  // lastBaseTip is estimated tip WITHOUT user offset (we store raw base separately)
  const desiredNorm = canvasToNorm(canvasPoint);
  config.estimation.offset = {
    x: desiredNorm.x - state.lastBaseTip.x,
    y: desiredNorm.y - state.lastBaseTip.y,
  };
  state.tipCalibrated = true;
  state.awaitingTipTap = false;
  drawing.setCalibrationTarget(canvasPoint);
  setBanner("準備完了 — ペン握り形のときだけインクが出ます", true);
  setMessage(
    `ペン先を設定しました。offset=(${config.estimation.offset.x.toFixed(3)}, ${config.estimation.offset.y.toFixed(3)})`,
    { toast: true },
  );
}

function onCanvasPointerDown(e) {
  if (!state.awaitingTipTap) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  applyTipFromCanvasPoint(canvasPointFromEvent(e));
}

function endInkStroke() {
  if (state.strokeActive) {
    drawing.endStroke();
    state.strokeActive = false;
  }
  state.inking = false;
  setPill(els.inkStatus, "インク: OFF", false);
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

  if (result) {
    if (result.landmarks?.length) {
      const landmarks = result.landmarks[0];
      state.lastLandmarks = landmarks;
      state.lastGrip = estimateGripScore(landmarks);
      state.gripping = state.lastGrip >= state.gripThreshold;

      setPill(els.handStatus, "手: 検出中", true);
      setPill(
        els.gripStatus,
        state.gripping ? `握り: ON (${state.lastGrip.toFixed(2)})` : `握り: OFF (${state.lastGrip.toFixed(2)})`,
        state.gripping,
      );

      const baseOnly = estimatePenTip(config.estimation.mode, landmarks, {
        L: config.estimation.L,
        offset: { x: 0, y: 0 },
      });
      if (baseOnly) {
        // Raw geometric tip (no user offset) — used when assigning pen tip
        state.lastBaseTip = { x: baseOnly.x, y: baseOnly.y };
      }

      const estimated = estimatePenTip(config.estimation.mode, landmarks, {
        L: config.estimation.L,
        offset: config.estimation.offset,
      });

      if (estimated) {
        const smooth = smoother.update({ x: estimated.x, y: estimated.y }, now);
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

        // Ink only while calibrated AND gripping (pen-hold pose)
        const shouldInk = state.tipCalibrated && state.gripping && canvasPoint;
        if (shouldInk) {
          state.inking = true;
          setPill(els.inkStatus, "インク: ON", true);
          if (!state.strokeActive) {
            drawing.beginStroke(canvasPoint);
            state.strokeActive = true;
          } else {
            drawing.continueStroke(canvasPoint);
          }
          if (!state.awaitingTipTap) {
            setBanner("描画中（ペン握り形）", true);
          }
        } else {
          if (state.strokeActive) endInkStroke();
          else {
            state.inking = false;
            setPill(els.inkStatus, "インク: OFF", false);
          }
          if (state.tipCalibrated && !state.awaitingTipTap) {
            setBanner(
              state.gripping ? "インク待機" : "ペン握り形にするとインクが出ます",
              false,
            );
          }
        }
      }
    } else {
      setPill(els.handStatus, "手: 未検出", false);
      setPill(els.gripStatus, "握り: OFF", false);
      state.lastLandmarks = null;
      state.lastBaseTip = null;
      state.lastSmoothTip = null;
      state.lastGrip = 0;
      state.gripping = false;
      clearerFrame();
      endInkStroke();
      drawing.setCursor(null);
      smoother.reset();
      if (state.tipCalibrated && !state.awaitingTipTap) {
        setBanner("手が見つかりません");
      }
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

function updateMetrics() {
  const tip = state.lastSmoothTip;
  const tipText = tip ? `(${tip.x.toFixed(3)}, ${tip.y.toFixed(3)})` : "—";
  els.metrics.textContent =
    `grip: ${state.lastGrip.toFixed(2)} | tip: ${tipText} | fps: ${state.fps} | calibrated: ${state.tipCalibrated ? "yes" : "no"}`;
}

// UI
els.btnStartCamera.addEventListener("click", onStartCamera);
els.btnSetTip.addEventListener("click", onSetTip);
els.btnClear.addEventListener("click", () => {
  drawing.clear();
  setMessage("線を消去しました。ペン先設定は保持しています。", { toast: true });
});
els.btnOpenSettings.addEventListener("click", openSettings);
els.btnCloseSettings.addEventListener("click", closeSettings);
els.settingsBackdrop.addEventListener("click", closeSettings);

els.drawCanvas.addEventListener("pointerdown", onCanvasPointerDown, { passive: false });
els.canvasWrap?.addEventListener("pointerdown", onCanvasPointerDown, { passive: false });

els.estimationMode.addEventListener("change", (e) => {
  config.estimation.mode = e.target.value;
  smoother.reset();
});
els.smoothingMode.addEventListener("change", (e) => {
  config.smoothing.mode = e.target.value;
  smoother.setMode(config.smoothing.mode);
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
els.gripThreshold.addEventListener("input", (e) => {
  state.gripThreshold = Number(e.target.value);
  els.gripThresholdValue.textContent = state.gripThreshold.toFixed(2);
});

window.addEventListener("resize", syncCanvasSize);
window.addEventListener("orientationchange", () => setTimeout(syncCanvasSize, 250));
window.addEventListener("beforeunload", stopAll);

syncCanvasSize();
setBanner("カメラを開始してください");
setMessage("カメラで手の骨格を検知し、ペン先を指定すると、握り形のときだけ描けます。");
