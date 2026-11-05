import { config } from "./config.js";
import { startCamera, stopCamera } from "./camera.js";
import { createHandTracker } from "./handTracker.js";
import { estimatePenTip, estimateGripScore } from "./penTipEstimator.js";
import { PointSmoother } from "./smoother.js";
import { toDrawCanvas } from "./coordinateMapper.js";
import { DrawingEngine } from "./drawingEngine.js";
import { drawHandOverlay, clearOverlay } from "./overlay.js";
import { createOnscreenPenController } from "./onscreenPen.js";

const els = {
  video: document.getElementById("webcam"),
  overlay: document.getElementById("overlay"),
  drawCanvas: document.getElementById("drawCanvas"),
  cameraPanel: document.getElementById("cameraPanel"),
  drawPanel: document.getElementById("drawPanel"),
  workspace: document.querySelector(".workspace"),
  onscreenControls: document.getElementById("onscreenControls"),
  cameraControls: document.getElementById("cameraControls"),
  estimationLabel: document.getElementById("estimationLabel"),
  penLengthLabel: document.getElementById("penLengthLabel"),
  btnPlaceHand: document.getElementById("btnPlaceHand"),
  btnToggleDraw: document.getElementById("btnToggleDraw"),
  btnClear: document.getElementById("btnClear"),
  btnStartCamera: document.getElementById("btnStartCamera"),
  btnCalibrate: document.getElementById("btnCalibrate"),
  btnToggleDrawCam: document.getElementById("btnToggleDrawCam"),
  btnClearCam: document.getElementById("btnClearCam"),
  estimationMode: document.getElementById("estimationMode"),
  smoothingMode: document.getElementById("smoothingMode"),
  guideMode: document.getElementById("guideMode"),
  penLength: document.getElementById("penLength"),
  penLengthValue: document.getElementById("penLengthValue"),
  emaAlpha: document.getElementById("emaAlpha"),
  emaAlphaValue: document.getElementById("emaAlphaValue"),
  message: document.getElementById("message"),
  metrics: document.getElementById("metrics"),
  holdStatus: document.getElementById("holdStatus"),
  holdBanner: document.getElementById("holdBanner"),
  toast: document.getElementById("toast"),
  handStatus: document.getElementById("handStatus"),
  drawStatus: document.getElementById("drawStatus"),
  settingsModal: document.getElementById("settingsModal"),
  btnOpenSettings: document.getElementById("btnOpenSettings"),
  btnCloseSettings: document.getElementById("btnCloseSettings"),
  settingsBackdrop: document.getElementById("settingsBackdrop"),
  highSensitivity: document.getElementById("highSensitivity"),
  modeRadios: document.querySelectorAll('input[name="inputMode"]'),
};

let toastTimer = 0;

const state = {
  inputMode: "onscreen",
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

const onscreen = createOnscreenPenController({
  canvas: els.drawCanvas,
  surface: document.getElementById("canvasWrap") || els.drawCanvas,
  drawing,
  smoother,
  holdSeconds: 5,
  highSensitivity: true,
  onStatus({ message, phase, holdProgress = 0, weakContact = false }) {
    setMessage(message, { toast: weakContact || phase === "pickTip" || phase === "ready" });
    updateHoldUi(phase, holdProgress, weakContact);
    els.btnToggleDraw.disabled = !(phase === "ready" || phase === "drawing");
    const drawingOn = phase === "drawing";
    els.btnToggleDraw.textContent = drawingOn ? "描画停止" : "描画開始";
    els.btnToggleDraw.classList.toggle("active", drawingOn);
    setPill(els.drawStatus, drawingOn ? "描画: ON" : "描画: OFF", drawingOn);
    updateOnscreenMetrics();
  },
  onContacts(contacts, tip, calibTip, calibAnchor, holdProgress = 0, meta = {}) {
    drawing.setContactDebug({
      contacts,
      tip,
      calibTip,
      calibAnchor,
      holdProgress,
      meta,
    });
    const soft = Boolean(meta.softPresence);
    setPill(
      els.handStatus,
      contacts.length
        ? `接触: ${contacts.length}点`
        : soft
          ? "接触: 弱い"
          : "接触: なし",
      contacts.length > 0 || soft,
    );
    updateHoldUi(onscreen.state.phase, holdProgress, Boolean(meta.weakContact));
    updateOnscreenMetrics(contacts, tip);
  },
});

function updateHoldUi(phase, holdProgress = 0, weakContact = false) {
  const held = holdProgress * 5;
  setPill(
    els.holdStatus,
    weakContact
      ? `保持: ${held.toFixed(1)} / 5.0秒（弱い）`
      : `保持: ${held.toFixed(1)} / 5.0秒`,
    holdProgress > 0,
  );

  if (!els.holdBanner) return;
  els.holdBanner.classList.remove("hidden", "ready");
  if (phase === "placeHand") {
    const left = Math.max(0, 5 - held);
    if (holdProgress <= 0) {
      els.holdBanner.textContent = "手のひら/指の腹もつけて5秒（小指側だけは反応しにくい）";
    } else if (weakContact) {
      els.holdBanner.textContent = `接触が弱い… 進捗 ${(holdProgress * 100).toFixed(0)}% もう少し押しつけ`;
    } else {
      els.holdBanner.textContent = `手を認識中… あと ${left.toFixed(1)} 秒`;
    }
  } else if (phase === "pickTip") {
    els.holdBanner.classList.add("ready");
    els.holdBanner.textContent = "想定ペン先をタップして設定";
  } else if (phase === "ready") {
    els.holdBanner.classList.add("ready");
    els.holdBanner.textContent = "ペン先設定済み — 描画開始できます";
  } else if (phase === "drawing") {
    els.holdBanner.classList.add("ready");
    els.holdBanner.textContent = "描画中";
  } else {
    els.holdBanner.textContent = "キャンバスに手を置いて5秒待つ";
  }
}

function setMessage(text, { toast = true } = {}) {
  if (els.message) els.message.textContent = text;
  if (!toast || !els.toast) return;
  els.toast.hidden = false;
  els.toast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
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

function updateOnscreenMetrics(contacts = onscreen.getContacts(), tip = onscreen.getTip()) {
  const offset = onscreen.getOffset();
  const tipText = tip ? `(${tip.x.toFixed(0)}, ${tip.y.toFixed(0)})` : "—";
  const offText = offset
    ? `(${offset.x.toFixed(0)}, ${offset.y.toFixed(0)})`
    : "—";
  els.metrics.textContent = `contacts: ${contacts.length} | tip: ${tipText} | offset: ${offText}`;
}

function setInputMode(mode) {
  state.inputMode = mode;
  const onscreenMode = mode === "onscreen";

  els.cameraPanel.hidden = onscreenMode;
  els.onscreenControls.hidden = !onscreenMode;
  els.cameraControls.hidden = onscreenMode;
  els.estimationLabel.hidden = onscreenMode;
  els.penLengthLabel.hidden = onscreenMode;
  els.workspace.classList.toggle("camera-mode", !onscreenMode);

  drawing.clear();
  drawing.setContactDebug(null);
  drawing.setCalibrationTarget(null);
  drawing.setCursor(null);
  smoother.reset();

  if (onscreenMode) {
    stopCameraMode();
    onscreen.bind();
    onscreen.beginPlaceHand();
    setPill(els.handStatus, "接触: なし", false);
    setPill(els.drawStatus, "描画: OFF", false);
    updateHoldUi("placeHand", 0);
  } else {
    onscreen.unbind();
    drawing.setContactDebug(null);
    if (els.holdBanner) els.holdBanner.classList.add("hidden");
    setMessage("カメラを開始し、空中でペン握り形の手をカメラに見せてください（比較用）。");
    setPill(els.handStatus, "手: 未検出", false);
    setPill(els.drawStatus, "描画: OFF", false);
    setPill(els.holdStatus, "保持: —", false);
  }

  // Layout settles then resize canvas to full available area
  requestAnimationFrame(() => {
    syncCanvasSize();
    requestAnimationFrame(syncCanvasSize);
  });
}

function stopCameraMode() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  stopCamera(els.video, state.stream);
  state.stream = null;
  state.tracker?.close();
  state.tracker = null;
  state.drawingEnabled = false;
  state.strokeActive = false;
  clearOverlay(els.overlay);
}

async function onStartCamera() {
  try {
    setMessage("カメラと MediaPipe モデルを読み込み中…");
    els.btnStartCamera.disabled = true;

    state.stream = await startCamera(els.video, config.camera);
    state.tracker = await createHandTracker(config.mediapipe, config.hand);

    syncCanvasSize();
    state.running = true;
    els.btnCalibrate.disabled = false;
    els.btnToggleDrawCam.disabled = false;
    els.btnClearCam.disabled = false;
    setMessage(
      "手が映ったら骨格と仮想ペン先が出ます。比較用モードです。本命検証は「画面に手を置く」側です。",
    );
    loop();
  } catch (err) {
    console.error(err);
    setMessage(`カメラ起動に失敗しました: ${err.message || err}`);
  } finally {
    els.btnStartCamera.disabled = false;
  }
}

function onToggleDrawCam() {
  state.drawingEnabled = !state.drawingEnabled;
  if (!state.drawingEnabled) {
    state.strokeActive = false;
    drawing.endStroke();
  }
  els.btnToggleDrawCam.textContent = state.drawingEnabled ? "描画停止" : "描画開始";
  els.btnToggleDrawCam.classList.toggle("active", state.drawingEnabled);
  setPill(els.drawStatus, state.drawingEnabled ? "描画: ON" : "描画: OFF", state.drawingEnabled);
}

function onCalibrateCam() {
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
    els.btnToggleDrawCam.textContent = "描画開始";
    els.btnToggleDrawCam.classList.remove("active");
    setPill(els.drawStatus, "描画: OFF", false);
    drawing.setCalibrationTarget(target);
    els.btnCalibrate.textContent = "この位置で確定";
    setMessage("仮想ペン先を中央の十字に重ねて、もう一度押して確定してください。");
    return;
  }

  if (!state.lastRawTip) {
    setMessage("手が検出されていません。");
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

function clearerFrame() {
  const videoW = els.video.videoWidth || els.overlay.width || 640;
  const videoH = els.video.videoHeight || els.overlay.height || 480;
  if (els.overlay.width !== videoW || els.overlay.height !== videoH) {
    els.overlay.width = videoW;
    els.overlay.height = videoH;
  }
  clearOverlay(els.overlay);
}

function updateCameraMetrics() {
  const tip = state.lastSmoothTip;
  const tipText = tip ? `(${tip.x.toFixed(3)}, ${tip.y.toFixed(3)})` : "—";
  els.metrics.textContent =
    `Pen: ${tipText} | grip: ${state.lastGrip.toFixed(2)} | fps: ${state.fps} | score: ${state.lastScore.toFixed(2)}`;
}

function loop() {
  if (!state.running || state.inputMode !== "camera") return;

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

  updateCameraMetrics();
  state.rafId = requestAnimationFrame(loop);
}

// Settings modal
els.btnOpenSettings.addEventListener("click", openSettings);
els.btnCloseSettings.addEventListener("click", closeSettings);
els.settingsBackdrop.addEventListener("click", closeSettings);

// Mode switching
for (const radio of els.modeRadios) {
  radio.addEventListener("change", () => {
    if (radio.checked) {
      setInputMode(radio.value);
      closeSettings();
    }
  });
}

// On-screen controls
els.btnPlaceHand.addEventListener("click", () => {
  onscreen.beginPlaceHand();
});
els.btnToggleDraw.addEventListener("click", () => {
  const enable = onscreen.state.phase !== "drawing";
  onscreen.setDrawingEnabled(enable);
});
els.btnClear.addEventListener("click", () => {
  drawing.clear();
  setMessage("線を消去しました。手の位置とペン先指定は保持しています。");
});

// Camera controls
els.btnStartCamera.addEventListener("click", onStartCamera);
els.btnToggleDrawCam.addEventListener("click", onToggleDrawCam);
els.btnClearCam.addEventListener("click", () => drawing.clear());
els.btnCalibrate.addEventListener("click", onCalibrateCam);

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

els.highSensitivity?.addEventListener("change", (e) => {
  onscreen.setHighSensitivity(e.target.checked);
});

window.addEventListener("resize", syncCanvasSize);
window.addEventListener("orientationchange", () => {
  setTimeout(syncCanvasSize, 250);
});
window.addEventListener("beforeunload", () => {
  stopCameraMode();
  onscreen.unbind();
});

setInputMode("onscreen");
syncCanvasSize();
