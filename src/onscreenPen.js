/**
 * On-screen hand mode (iPad):
 * 1) Keep hand on canvas for 5+ seconds → auto lock hand anchor
 * 2) User taps intended virtual pen tip
 * 3) tip = currentAnchor + (tip0 - anchor0)
 */

export const HOLD_SECONDS_REQUIRED = 5;

export function centroid(points) {
  if (!points.length) return null;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function createOnscreenPenController({
  canvas,
  drawing,
  smoother,
  onStatus,
  onContacts,
  holdSeconds = HOLD_SECONDS_REQUIRED,
}) {
  const state = {
    phase: "idle", // idle | placeHand | pickTip | ready | drawing
    activePointers: new Map(), // pointerId -> {x,y}
    holdStartedAt: null,
    holdProgress: 0,
    holdSamples: [],
    ignorePointerIds: new Set(), // contacts already down when entering pickTip
    calibAnchor: null,
    calibTip: null,
    offset: null,
    strokeActive: false,
    rafId: 0,
  };

  function setPhase(phase, message) {
    state.phase = phase;
    onStatus?.({
      phase,
      message,
      offset: state.offset,
      contacts: currentContacts(),
      holdProgress: state.holdProgress,
      holdSecondsLeft: Math.max(0, holdSeconds * (1 - state.holdProgress)),
    });
  }

  function emitStatus(message) {
    onStatus?.({
      phase: state.phase,
      message,
      offset: state.offset,
      contacts: currentContacts(),
      holdProgress: state.holdProgress,
      holdSecondsLeft: Math.max(0, holdSeconds * (1 - state.holdProgress)),
    });
  }

  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(rect.width, 1);
    const scaleY = canvas.height / Math.max(rect.height, 1);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function currentContacts() {
    return [...state.activePointers.values()];
  }

  function currentAnchor() {
    return centroid(currentContacts());
  }

  function currentTip() {
    if (!state.offset) return null;
    const anchor = currentAnchor();
    if (!anchor) return null;
    return {
      x: anchor.x + state.offset.x,
      y: anchor.y + state.offset.y,
    };
  }

  function paintDebug() {
    onContacts?.(
      currentContacts(),
      currentTip(),
      state.calibTip,
      state.calibAnchor,
      state.holdProgress,
    );
  }

  function resetHold() {
    state.holdStartedAt = null;
    state.holdProgress = 0;
    state.holdSamples = [];
  }

  function beginPlaceHand() {
    state.calibAnchor = null;
    state.calibTip = null;
    state.offset = null;
    state.strokeActive = false;
    state.ignorePointerIds.clear();
    drawing.endStroke();
    drawing.setCalibrationTarget(null);
    drawing.setCursor(null);
    resetHold();
    setPhase(
      "placeHand",
      `ペン握り形でキャンバスに手を置き、${holdSeconds}秒間そのまま維持してください。`,
    );
    paintDebug();
    startHoldLoop();
  }

  function lockHandFromHold() {
    if (state.phase !== "placeHand") return;
    const samples = state.holdSamples.length
      ? state.holdSamples
      : currentContacts().length
        ? [centroid(currentContacts())]
        : [];
    if (!samples.length) {
      resetHold();
      emitStatus("接触が途切れました。もう一度手を置いてください。");
      return;
    }

    state.calibAnchor = centroid(samples.filter(Boolean));
    // Existing contacts should not instantly count as tip taps.
    state.ignorePointerIds = new Set(state.activePointers.keys());
    resetHold();
    setPhase(
      "pickTip",
      "手の位置を認識しました。想定するペン先の位置をタップして指定してください。",
    );
    paintDebug();
  }

  function updateHold(now = performance.now()) {
    if (state.phase !== "placeHand") return;

    const contacts = currentContacts();
    if (contacts.length === 0) {
      if (state.holdStartedAt) {
        resetHold();
        emitStatus(`手を置いてください。${holdSeconds}秒維持でペン先設定に進みます。`);
        paintDebug();
      }
      return;
    }

    if (!state.holdStartedAt) {
      state.holdStartedAt = now;
      state.holdSamples = [];
    }

    const c = centroid(contacts);
    if (c) state.holdSamples.push(c);
    // Keep sample list bounded
    if (state.holdSamples.length > 120) {
      state.holdSamples.splice(0, state.holdSamples.length - 120);
    }

    const elapsed = (now - state.holdStartedAt) / 1000;
    state.holdProgress = Math.min(1, elapsed / holdSeconds);
    const left = Math.max(0, holdSeconds - elapsed);

    emitStatus(
      left > 0.05
        ? `手を認識中… あと ${left.toFixed(1)} 秒そのまま置いてください`
        : "手の位置を確定しています…",
    );
    paintDebug();

    if (elapsed >= holdSeconds) {
      lockHandFromHold();
    }
  }

  function startHoldLoop() {
    cancelAnimationFrame(state.rafId);
    const tick = (t) => {
      if (state.phase === "placeHand") {
        updateHold(t);
        state.rafId = requestAnimationFrame(tick);
      }
    };
    state.rafId = requestAnimationFrame(tick);
  }

  function pickTipAt(point) {
    if (state.phase !== "pickTip" || !state.calibAnchor) return false;
    state.calibTip = point;
    state.offset = {
      x: point.x - state.calibAnchor.x,
      y: point.y - state.calibAnchor.y,
    };
    drawing.setCalibrationTarget(point);
    setPhase(
      "ready",
      `ペン先を設定しました。offset=(${state.offset.x.toFixed(0)}, ${state.offset.y.toFixed(0)})。「描画開始」で線を引けます。`,
    );
    paintDebug();
    return true;
  }

  function setDrawingEnabled(enabled) {
    if (!state.offset) {
      setPhase("idle", "先に手を5秒置いてから、想定ペン先を指定してください。");
      return false;
    }
    if (enabled) {
      state.strokeActive = false;
      drawing.endStroke();
      setPhase("drawing", "描画中。ペン握り形のまま手全体を動かしてください。");
    } else {
      state.strokeActive = false;
      drawing.endStroke();
      setPhase("ready", "描画を停止しました。");
    }
    return true;
  }

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const p = canvasPointFromEvent(e);
    state.activePointers.set(e.pointerId, p);

    if (state.phase === "pickTip") {
      if (!state.ignorePointerIds.has(e.pointerId)) {
        pickTipAt(p);
      }
    } else if (state.phase === "idle") {
      // Auto-start hold detection when user first puts hand down
      beginPlaceHand();
      state.activePointers.set(e.pointerId, p);
    }

    paintDebug();
    if (state.phase === "placeHand") updateHold(performance.now());
    maybeDraw(e.timeStamp);
  }

  function onPointerMove(e) {
    if (!state.activePointers.has(e.pointerId)) return;
    e.preventDefault();
    state.activePointers.set(e.pointerId, canvasPointFromEvent(e));
    paintDebug();
    maybeDraw(e.timeStamp);
  }

  function onPointerUp(e) {
    state.activePointers.delete(e.pointerId);
    state.ignorePointerIds.delete(e.pointerId);

    if (state.phase === "placeHand" && state.activePointers.size === 0) {
      resetHold();
      emitStatus(`手が離れました。もう一度置き、${holdSeconds}秒維持してください。`);
    }

    if (state.activePointers.size === 0 && state.strokeActive) {
      drawing.endStroke();
      state.strokeActive = false;
      smoother.reset();
    }
    paintDebug();
  }

  function maybeDraw(timestampMs) {
    if (state.phase !== "drawing" || !state.offset) return;
    const rawTip = currentTip();
    if (!rawTip) {
      if (state.strokeActive) {
        drawing.endStroke();
        state.strokeActive = false;
        smoother.reset();
      }
      drawing.setCursor(null);
      return;
    }

    const tip = smoother.update(rawTip, timestampMs || performance.now());
    drawing.setCursor(tip);

    if (!state.strokeActive) {
      drawing.beginStroke(tip);
      state.strokeActive = true;
    } else {
      drawing.continueStroke(tip);
    }
  }

  function bind() {
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
  }

  function unbind() {
    cancelAnimationFrame(state.rafId);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    state.activePointers.clear();
    resetHold();
  }

  return {
    state,
    bind,
    unbind,
    beginPlaceHand,
    setDrawingEnabled,
    getOffset: () => state.offset,
    getContacts: currentContacts,
    getTip: currentTip,
    getHoldProgress: () => state.holdProgress,
  };
}

export function drawContactDebug(ctx, contacts, tip, calibTip, calibAnchor, holdProgress = 0) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  if (holdProgress > 0 && holdProgress < 1) {
    ctx.save();
    ctx.fillStyle = "rgba(15, 107, 76, 0.12)";
    ctx.fillRect(0, 0, w * holdProgress, 10);
    ctx.fillStyle = "#0f6b4c";
    ctx.fillRect(0, 0, w * holdProgress, 10);
    ctx.restore();
  }

  ctx.save();
  for (const c of contacts) {
    ctx.beginPath();
    ctx.fillStyle = "rgba(15, 107, 76, 0.35)";
    ctx.strokeStyle = "rgba(15, 107, 76, 0.9)";
    ctx.lineWidth = 2;
    ctx.arc(c.x, c.y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (calibAnchor) {
    ctx.beginPath();
    ctx.strokeStyle = "#5c554a";
    ctx.lineWidth = 2;
    ctx.arc(calibAnchor.x, calibAnchor.y, 12, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (calibTip) {
    ctx.beginPath();
    ctx.strokeStyle = "#0f6b4c";
    ctx.lineWidth = 3;
    ctx.moveTo(calibTip.x - 18, calibTip.y);
    ctx.lineTo(calibTip.x + 18, calibTip.y);
    ctx.moveTo(calibTip.x, calibTip.y - 18);
    ctx.lineTo(calibTip.x, calibTip.y + 18);
    ctx.stroke();
  }

  if (tip) {
    ctx.beginPath();
    ctx.fillStyle = "#0f6b4c";
    ctx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
