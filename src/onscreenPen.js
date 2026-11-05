/**
 * On-screen hand mode (iPad):
 * 1) Keep hand on canvas for 5+ seconds (gap-tolerant) → lock hand anchor
 * 2) User taps intended virtual pen tip
 * 3) tip = currentAnchor + (tip0 - anchor0)
 *
 * Note: pinky-side / knife-edge contact is hard for capacitive + iPadOS palm
 * rejection. We accumulate contact time with a grace gap, and also listen to
 * Touch Events as a fallback beside Pointer Events.
 */

export const HOLD_SECONDS_REQUIRED = 5;
/** Allow brief contact dropouts without wiping progress (ms). */
export const HOLD_GAP_GRACE_MS = 900;
/** Treat very recent cancelled/lost touches as soft presence (ms). */
export const SOFT_PRESENCE_MS = 450;

/**
 * Palm Rejection cannot be disabled from Web/App Store apps.
 * "highSensitivity" only maximizes use of contacts the OS still delivers.
 */
export const SENSITIVITY = {
  normal: {
    holdSeconds: 5,
    gapGraceMs: 900,
    softPresenceMs: 450,
    softAccumRate: 0.55,
    decayRate: 0.35,
  },
  high: {
    holdSeconds: 3.5,
    gapGraceMs: 1600,
    softPresenceMs: 900,
    softAccumRate: 0.85,
    decayRate: 0.18,
  },
};

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

export function weightedCentroid(points) {
  if (!points.length) return null;
  let x = 0;
  let y = 0;
  let wSum = 0;
  for (const p of points) {
    const w = Math.max(1, Number(p.weight) || 1);
    x += p.x * w;
    y += p.y * w;
    wSum += w;
  }
  return { x: x / wSum, y: y / wSum };
}

export function createOnscreenPenController({
  canvas,
  surface = canvas,
  drawing,
  smoother,
  onStatus,
  onContacts,
  holdSeconds = HOLD_SECONDS_REQUIRED,
  gapGraceMs = HOLD_GAP_GRACE_MS,
  highSensitivity = true,
}) {
  const state = {
    phase: "idle", // idle | placeHand | pickTip | ready | drawing
    activePointers: new Map(), // id -> {x,y,source,weight,radius}
    holdAccumMs: 0,
    holdProgress: 0,
    holdSamples: [],
    lastContactAt: 0,
    lastSoftPresenceAt: 0,
    lastTickAt: 0,
    weakContact: false,
    highSensitivity: Boolean(highSensitivity),
    ignorePointerIds: new Set(),
    calibAnchor: null,
    calibTip: null,
    offset: null,
    strokeActive: false,
    rafId: 0,
    windowCaptureBound: false,
  };

  const profile = () =>
    state.highSensitivity ? SENSITIVITY.high : SENSITIVITY.normal;
  let activeHoldSeconds = state.highSensitivity
    ? SENSITIVITY.high.holdSeconds
    : holdSeconds;
  let activeGapGraceMs = state.highSensitivity
    ? SENSITIVITY.high.gapGraceMs
    : gapGraceMs;

  function setPhase(phase, message) {
    state.phase = phase;
    onStatus?.({
      phase,
      message,
      offset: state.offset,
      contacts: currentContacts(),
      holdProgress: state.holdProgress,
      holdSecondsLeft: Math.max(0, holdSeconds * (1 - state.holdProgress)),
      weakContact: state.weakContact,
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
      weakContact: state.weakContact,
    });
  }

  function canvasPointFromClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(rect.width, 1);
    const scaleY = canvas.height / Math.max(rect.height, 1);
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function currentContacts() {
    return [...state.activePointers.values()].map(({ x, y, weight, radius }) => ({
      x,
      y,
      weight,
      radius,
    }));
  }

  function currentAnchor() {
    return weightedCentroid(currentContacts()) || centroid(currentContacts());
  }

  function clientInCanvas(clientX, clientY, pad = 24) {
    const r = canvas.getBoundingClientRect();
    return (
      clientX >= r.left - pad &&
      clientX <= r.right + pad &&
      clientY >= r.top - pad &&
      clientY <= r.bottom + pad
    );
  }

  function contactWeightFromSize(width, height, radiusX, radiusY) {
    const area = Math.max(width || 0, 0) * Math.max(height || 0, 0);
    const rArea = Math.max(radiusX || 0, 0) * Math.max(radiusY || 0, 0) * 4;
    // Larger blobs (more palm-like that still got through) weigh more.
    return Math.max(1, area, rArea, 1);
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

  function hasHardContact() {
    return state.activePointers.size > 0;
  }

  function hasSoftPresence(now = performance.now()) {
    const softMs = profile().softPresenceMs;
    return (
      hasHardContact() ||
      now - state.lastSoftPresenceAt <= softMs ||
      now - state.lastContactAt <= activeGapGraceMs
    );
  }

  function paintDebug() {
    onContacts?.(
      currentContacts(),
      currentTip(),
      state.calibTip,
      state.calibAnchor,
      state.holdProgress,
      {
        weakContact: state.weakContact,
        softPresence: hasSoftPresence(),
      },
    );
  }

  function resetHold({ keepPartial = false } = {}) {
    if (!keepPartial) {
      state.holdAccumMs = 0;
      state.holdProgress = 0;
      state.holdSamples = [];
    }
    state.lastTickAt = 0;
    state.weakContact = false;
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
    activeHoldSeconds = profile().holdSeconds;
    activeGapGraceMs = profile().gapGraceMs;
    setPhase(
      "placeHand",
      `手を置いて${activeHoldSeconds}秒維持してください。Palm Rejectionは解除できません。手のひら/指の腹を面でつけると精度が上がります。`,
    );
    paintDebug();
    startHoldLoop();
  }

  function setHighSensitivity(enabled) {
    state.highSensitivity = Boolean(enabled);
    activeHoldSeconds = profile().holdSeconds;
    activeGapGraceMs = profile().gapGraceMs;
    emitStatus(
      state.highSensitivity
        ? "高感度モードON（掌拒否は解除不可。途切れに強い判定＋大きめ接点を優先）"
        : "通常感度に戻しました（掌拒否は OS 側のままです）",
    );
  }

  function lockHandFromHold() {
    if (state.phase !== "placeHand") return;
    const samples = state.holdSamples.length
      ? state.holdSamples
      : currentContacts().length
        ? [centroid(currentContacts())]
        : [];
    if (!samples.length) {
      // Keep partial progress; ask user to re-seat hand
      state.weakContact = true;
      emitStatus(
        "接触が弱く位置を確定できません。手のひら側もつけて、もう少し押しつけてください。",
      );
      state.holdAccumMs = Math.max(0, state.holdAccumMs - 800);
      state.holdProgress = Math.min(1, state.holdAccumMs / (holdSeconds * 1000));
      return;
    }

    state.calibAnchor = weightedCentroid(samples.filter(Boolean)) || centroid(samples.filter(Boolean));
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

    if (!state.lastTickAt) state.lastTickAt = now;
    const dt = Math.min(50, Math.max(0, now - state.lastTickAt));
    state.lastTickAt = now;

    const hard = hasHardContact();
    const soft = hasSoftPresence(now);
    const gap = now - state.lastContactAt;

    if (hard) {
      state.lastContactAt = now;
      state.weakContact = false;
      state.holdAccumMs += dt;
      const c = currentAnchor();
      if (c) state.holdSamples.push(c);
      if (state.holdSamples.length > 160) {
        state.holdSamples.splice(0, state.holdSamples.length - 160);
      }
    } else if (soft && gap <= activeGapGraceMs) {
      state.weakContact = true;
      state.holdAccumMs += dt * profile().softAccumRate;
    } else if (state.holdAccumMs > 0 && gap > activeGapGraceMs) {
      state.weakContact = true;
      state.holdAccumMs = Math.max(0, state.holdAccumMs - dt * profile().decayRate);
      if (state.holdAccumMs <= 0) {
        state.holdSamples = [];
      }
    }

    state.holdProgress = Math.min(1, state.holdAccumMs / (activeHoldSeconds * 1000));
    const left = Math.max(0, activeHoldSeconds - state.holdAccumMs / 1000);

    let message;
    if (!hard && state.holdAccumMs <= 0) {
      message = `手を置いてください。掌拒否は解除不可です。手のひら/指の腹を面でつけて${activeHoldSeconds}秒。`;
    } else if (state.weakContact && !hard) {
      message = `接触が弱い/途切れ… 進捗 ${(state.holdProgress * 100).toFixed(0)}%（高感度でも OS が弾いた点は復活できません）`;
    } else if (left > 0.05) {
      message = `手を認識中… あと ${left.toFixed(1)} 秒`;
    } else {
      message = "手の位置を確定しています…";
    }

    emitStatus(message);
    paintDebug();

    if (state.holdAccumMs >= activeHoldSeconds * 1000) {
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

  function upsertContact(id, point, source, size = {}) {
    const weight = contactWeightFromSize(
      size.width,
      size.height,
      size.radiusX,
      size.radiusY,
    );
    const radius = Math.max(
      8,
      (Number(size.width) || 0) / 2,
      (Number(size.height) || 0) / 2,
      Number(size.radiusX) || 0,
      Number(size.radiusY) || 0,
      12,
    );
    state.activePointers.set(id, { ...point, source, weight, radius });
    state.lastContactAt = performance.now();
    state.lastSoftPresenceAt = state.lastContactAt;
  }

  function removeContact(id, { soft = false } = {}) {
    state.activePointers.delete(id);
    state.ignorePointerIds.delete(id);
    if (soft) {
      state.lastSoftPresenceAt = performance.now();
      state.weakContact = true;
    }
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

  function pointerSize(e) {
    return {
      width: e.width || 0,
      height: e.height || 0,
      radiusX: e.width ? e.width / 2 : 0,
      radiusY: e.height ? e.height / 2 : 0,
    };
  }

  function touchSize(t) {
    return {
      width: (t.radiusX || 0) * 2,
      height: (t.radiusY || 0) * 2,
      radiusX: t.radiusX || 0,
      radiusY: t.radiusY || 0,
    };
  }

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!clientInCanvas(e.clientX, e.clientY) && e.currentTarget === window) return;
    e.preventDefault();
    surface.setPointerCapture?.(e.pointerId);
    const p = canvasPointFromClient(e.clientX, e.clientY);
    const id = `p:${e.pointerId}`;
    upsertContact(id, p, "pointer", pointerSize(e));

    if (state.phase === "pickTip") {
      if (!state.ignorePointerIds.has(id) && !state.ignorePointerIds.has(e.pointerId)) {
        pickTipAt(p);
      }
    } else if (state.phase === "idle") {
      beginPlaceHand();
      upsertContact(id, p, "pointer", pointerSize(e));
    }

    paintDebug();
    if (state.phase === "placeHand") updateHold(performance.now());
    maybeDraw(e.timeStamp);
  }

  function onPointerMove(e) {
    const id = `p:${e.pointerId}`;
    if (!state.activePointers.has(id)) return;
    e.preventDefault();
    upsertContact(
      id,
      canvasPointFromClient(e.clientX, e.clientY),
      "pointer",
      pointerSize(e),
    );
    paintDebug();
    maybeDraw(e.timeStamp);
  }

  function onPointerUp(e) {
    removeContact(`p:${e.pointerId}`);
    if (state.activePointers.size === 0 && state.strokeActive) {
      drawing.endStroke();
      state.strokeActive = false;
      smoother.reset();
    }
    paintDebug();
  }

  function onPointerCancel(e) {
    // iPad palm rejection often cancels edge/pinky contacts — keep soft presence
    removeContact(`p:${e.pointerId}`, { soft: true });
    paintDebug();
  }

  function onTouchStart(e) {
    // During calibration, accept canvas-local touches even if OS partially filters pointer stream.
    if (e.currentTarget === window) {
      let any = false;
      for (const t of e.changedTouches) {
        if (clientInCanvas(t.clientX, t.clientY)) any = true;
      }
      if (!any) return;
    }
    e.preventDefault();
    if (state.phase === "idle") beginPlaceHand();
    for (const t of e.changedTouches) {
      if (!clientInCanvas(t.clientX, t.clientY) && e.currentTarget === window) continue;
      const id = `t:${t.identifier}`;
      upsertContact(id, canvasPointFromClient(t.clientX, t.clientY), "touch", touchSize(t));
      if (state.phase === "pickTip") {
        if (!state.ignorePointerIds.has(id) && !state.ignorePointerIds.has(t.identifier)) {
          pickTipAt(canvasPointFromClient(t.clientX, t.clientY));
        }
      }
    }
    paintDebug();
    if (state.phase === "placeHand") updateHold(performance.now());
  }

  function onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const id = `t:${t.identifier}`;
      if (!state.activePointers.has(id)) continue;
      upsertContact(id, canvasPointFromClient(t.clientX, t.clientY), "touch", touchSize(t));
    }
    paintDebug();
    maybeDraw(e.timeStamp);
  }

  function onTouchEnd(e) {
    for (const t of e.changedTouches) {
      removeContact(`t:${t.identifier}`);
    }
    if (state.activePointers.size === 0 && state.strokeActive) {
      drawing.endStroke();
      state.strokeActive = false;
      smoother.reset();
    }
    paintDebug();
  }

  function onTouchCancel(e) {
    for (const t of e.changedTouches) {
      removeContact(`t:${t.identifier}`, { soft: true });
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
    surface.style.touchAction = "none";

    const opts = { passive: false };
    surface.addEventListener("pointerdown", onPointerDown, opts);
    surface.addEventListener("pointermove", onPointerMove, opts);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerCancel);
    surface.addEventListener("touchstart", onTouchStart, opts);
    surface.addEventListener("touchmove", onTouchMove, opts);
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchCancel);

    // Extra window capture during hand placement: recover borderline contacts
    // that still reach JS but miss the canvas target due to rejection jitter.
    if (!state.windowCaptureBound) {
      window.addEventListener("pointerdown", onPointerDown, opts);
      window.addEventListener("touchstart", onTouchStart, opts);
      window.addEventListener("touchmove", onTouchMove, opts);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("touchcancel", onTouchCancel);
      state.windowCaptureBound = true;
    }
  }

  function unbind() {
    cancelAnimationFrame(state.rafId);
    surface.removeEventListener("pointerdown", onPointerDown);
    surface.removeEventListener("pointermove", onPointerMove);
    surface.removeEventListener("pointerup", onPointerUp);
    surface.removeEventListener("pointercancel", onPointerCancel);
    surface.removeEventListener("touchstart", onTouchStart);
    surface.removeEventListener("touchmove", onTouchMove);
    surface.removeEventListener("touchend", onTouchEnd);
    surface.removeEventListener("touchcancel", onTouchCancel);
    if (state.windowCaptureBound) {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("touchcancel", onTouchCancel);
      state.windowCaptureBound = false;
    }
    state.activePointers.clear();
    resetHold();
  }

  return {
    state,
    bind,
    unbind,
    beginPlaceHand,
    setDrawingEnabled,
    setHighSensitivity,
    getOffset: () => state.offset,
    getContacts: currentContacts,
    getTip: currentTip,
    getHoldProgress: () => state.holdProgress,
  };
}

export function drawContactDebug(
  ctx,
  contacts,
  tip,
  calibTip,
  calibAnchor,
  holdProgress = 0,
  meta = {},
) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  if (holdProgress > 0) {
    ctx.save();
    ctx.fillStyle = meta.weakContact
      ? "rgba(180, 110, 20, 0.85)"
      : "#0f6b4c";
    ctx.fillRect(0, 0, w * Math.min(1, holdProgress), 10);
    ctx.restore();
  }

  ctx.save();
  for (const c of contacts) {
    const r = Math.max(16, Math.min(48, Number(c.radius) || 28));
    ctx.beginPath();
    ctx.fillStyle = meta.weakContact
      ? "rgba(180, 110, 20, 0.35)"
      : "rgba(15, 107, 76, 0.35)";
    ctx.strokeStyle = meta.weakContact
      ? "rgba(180, 110, 20, 0.95)"
      : "rgba(15, 107, 76, 0.9)";
    ctx.lineWidth = 2;
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (!contacts.length && meta.softPresence) {
    ctx.fillStyle = "rgba(180, 110, 20, 0.12)";
    ctx.fillRect(0, 0, w, h);
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
