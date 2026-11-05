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
  surface = canvas,
  drawing,
  smoother,
  onStatus,
  onContacts,
  holdSeconds = HOLD_SECONDS_REQUIRED,
  gapGraceMs = HOLD_GAP_GRACE_MS,
}) {
  const state = {
    phase: "idle", // idle | placeHand | pickTip | ready | drawing
    activePointers: new Map(), // id -> {x,y,source}
    holdAccumMs: 0,
    holdProgress: 0,
    holdSamples: [],
    lastContactAt: 0,
    lastSoftPresenceAt: 0,
    lastTickAt: 0,
    weakContact: false,
    ignorePointerIds: new Set(),
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
    return [...state.activePointers.values()].map(({ x, y }) => ({ x, y }));
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

  function hasHardContact() {
    return state.activePointers.size > 0;
  }

  function hasSoftPresence(now = performance.now()) {
    return (
      hasHardContact() ||
      now - state.lastSoftPresenceAt <= SOFT_PRESENCE_MS ||
      now - state.lastContactAt <= gapGraceMs
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
    setPhase(
      "placeHand",
      `手を置いて${holdSeconds}秒維持してください。小指側だけより、手のひらや複数指を軽くつけると反応しやすいです。`,
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
      // Keep partial progress; ask user to re-seat hand
      state.weakContact = true;
      emitStatus(
        "接触が弱く位置を確定できません。手のひら側もつけて、もう少し押しつけてください。",
      );
      state.holdAccumMs = Math.max(0, state.holdAccumMs - 800);
      state.holdProgress = Math.min(1, state.holdAccumMs / (holdSeconds * 1000));
      return;
    }

    state.calibAnchor = centroid(samples.filter(Boolean));
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
      const c = centroid(currentContacts());
      if (c) state.holdSamples.push(c);
      if (state.holdSamples.length > 160) {
        state.holdSamples.splice(0, state.holdSamples.length - 160);
      }
    } else if (soft && gap <= gapGraceMs) {
      // Brief dropout: keep progress, mark as weak
      state.weakContact = true;
      // Still accumulate at reduced rate so intermittent pinky contact can finish
      state.holdAccumMs += dt * 0.55;
    } else if (state.holdAccumMs > 0 && gap > gapGraceMs) {
      // Long gap: decay slowly instead of hard reset (helps unstable edge contact)
      state.weakContact = true;
      state.holdAccumMs = Math.max(0, state.holdAccumMs - dt * 0.35);
      if (state.holdAccumMs <= 0) {
        state.holdSamples = [];
      }
    }

    state.holdProgress = Math.min(1, state.holdAccumMs / (holdSeconds * 1000));
    const left = Math.max(0, holdSeconds - state.holdAccumMs / 1000);

    let message;
    if (!hard && state.holdAccumMs <= 0) {
      message = `手を置いてください。小指側だけだと反応しにくいので、手のひらや指の腹も軽くつけて${holdSeconds}秒維持。`;
    } else if (state.weakContact && !hard) {
      message = `接触が弱い/途切れています… 進捗 ${(state.holdProgress * 100).toFixed(0)}%  もう少し押しつけつつ維持`;
    } else if (left > 0.05) {
      message = `手を認識中… あと ${left.toFixed(1)} 秒`;
    } else {
      message = "手の位置を確定しています…";
    }

    emitStatus(message);
    paintDebug();

    if (state.holdAccumMs >= holdSeconds * 1000) {
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

  function upsertContact(id, point, source) {
    state.activePointers.set(id, { ...point, source });
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

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    surface.setPointerCapture?.(e.pointerId);
    const p = canvasPointFromClient(e.clientX, e.clientY);
    const id = `p:${e.pointerId}`;
    upsertContact(id, p, "pointer");

    if (state.phase === "pickTip") {
      if (!state.ignorePointerIds.has(id) && !state.ignorePointerIds.has(e.pointerId)) {
        pickTipAt(p);
      }
    } else if (state.phase === "idle") {
      beginPlaceHand();
      upsertContact(id, p, "pointer");
    }

    paintDebug();
    if (state.phase === "placeHand") updateHold(performance.now());
    maybeDraw(e.timeStamp);
  }

  function onPointerMove(e) {
    const id = `p:${e.pointerId}`;
    if (!state.activePointers.has(id)) return;
    e.preventDefault();
    upsertContact(id, canvasPointFromClient(e.clientX, e.clientY), "pointer");
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
    e.preventDefault();
    if (state.phase === "idle") beginPlaceHand();
    for (const t of e.changedTouches) {
      const id = `t:${t.identifier}`;
      upsertContact(id, canvasPointFromClient(t.clientX, t.clientY), "touch");
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
      upsertContact(id, canvasPointFromClient(t.clientX, t.clientY), "touch");
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
    // Touch Events backup: helps when pointer stream is filtered inconsistently
    surface.addEventListener("touchstart", onTouchStart, opts);
    surface.addEventListener("touchmove", onTouchMove, opts);
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchCancel);
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
    ctx.beginPath();
    ctx.fillStyle = meta.weakContact
      ? "rgba(180, 110, 20, 0.35)"
      : "rgba(15, 107, 76, 0.35)";
    ctx.strokeStyle = meta.weakContact
      ? "rgba(180, 110, 20, 0.95)"
      : "rgba(15, 107, 76, 0.9)";
    ctx.lineWidth = 2;
    ctx.arc(c.x, c.y, 28, 0, Math.PI * 2);
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
