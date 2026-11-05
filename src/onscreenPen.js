/**
 * On-screen hand mode:
 * 1) Capture touch contacts as hand anchor (screen response points)
 * 2) User taps intended virtual pen tip
 * 3) tip = currentAnchor + (tip0 - anchor0)
 */

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
}) {
  const state = {
    phase: "idle", // idle | placeHand | pickTip | ready | drawing
    activePointers: new Map(), // pointerId -> {x,y}
    calibAnchor: null,
    calibTip: null,
    offset: null, // tip - anchor in canvas px
    strokeActive: false,
  };

  function setPhase(phase, message) {
    state.phase = phase;
    onStatus?.({ phase, message, offset: state.offset, contacts: currentContacts() });
  }

  function canvasPointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
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
    onContacts?.(currentContacts(), currentTip(), state.calibTip, state.calibAnchor);
  }

  function beginPlaceHand() {
    state.calibAnchor = null;
    state.calibTip = null;
    state.offset = null;
    state.strokeActive = false;
    drawing.endStroke();
    drawing.setCalibrationTarget(null);
    setPhase(
      "placeHand",
      "ペンを握る形でキャンバスに手を置いてください。接触点が表示されたら「手の位置を記録」を押します。",
    );
    paintDebug();
  }

  function recordHand() {
    const contacts = currentContacts();
    if (contacts.length === 0) {
      setPhase(
        "placeHand",
        "まだ接触がありません。手をキャンバスに置いたまま、もう一度押してください。",
      );
      return false;
    }
    state.calibAnchor = centroid(contacts);
    setPhase(
      "pickTip",
      "想定する仮想ペン先の位置を、キャンバス上でタップして指定してください。",
    );
    paintDebug();
    return true;
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
      `ペン先を記録しました。offset=(${state.offset.x.toFixed(0)}, ${state.offset.y.toFixed(0)})。「描画開始」後、手を動かして線を引けます。`,
    );
    paintDebug();
    return true;
  }

  function setDrawingEnabled(enabled) {
    if (!state.offset) {
      setPhase("idle", "先に手の位置記録と想定ペン先の指定を行ってください。");
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
    canvas.setPointerCapture?.(e.pointerId);
    const p = canvasPointFromEvent(e);
    state.activePointers.set(e.pointerId, p);

    if (state.phase === "pickTip") {
      pickTipAt(p);
      // tip tap is a designation, not a contact to keep forever if it was a quick tap
      // Keep it in activePointers until up — fine.
    }

    paintDebug();
    maybeDraw(e.timeStamp);
  }

  function onPointerMove(e) {
    if (!state.activePointers.has(e.pointerId)) return;
    state.activePointers.set(e.pointerId, canvasPointFromEvent(e));
    paintDebug();
    maybeDraw(e.timeStamp);
  }

  function onPointerUp(e) {
    state.activePointers.delete(e.pointerId);
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
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
  }

  function unbind() {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    state.activePointers.clear();
  }

  return {
    state,
    bind,
    unbind,
    beginPlaceHand,
    recordHand,
    setDrawingEnabled,
    getOffset: () => state.offset,
    getContacts: currentContacts,
    getTip: currentTip,
  };
}

export function drawContactDebug(ctx, contacts, tip, calibTip, calibAnchor) {
  ctx.save();
  for (const c of contacts) {
    ctx.beginPath();
    ctx.fillStyle = "rgba(15, 107, 76, 0.35)";
    ctx.strokeStyle = "rgba(15, 107, 76, 0.9)";
    ctx.lineWidth = 2;
    ctx.arc(c.x, c.y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (calibAnchor) {
    ctx.beginPath();
    ctx.strokeStyle = "#5c554a";
    ctx.lineWidth = 2;
    ctx.arc(calibAnchor.x, calibAnchor.y, 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (calibTip) {
    ctx.beginPath();
    ctx.strokeStyle = "#0f6b4c";
    ctx.lineWidth = 2;
    ctx.moveTo(calibTip.x - 14, calibTip.y);
    ctx.lineTo(calibTip.x + 14, calibTip.y);
    ctx.moveTo(calibTip.x, calibTip.y - 14);
    ctx.lineTo(calibTip.x, calibTip.y + 14);
    ctx.stroke();
  }

  if (tip) {
    ctx.beginPath();
    ctx.fillStyle = "#0f6b4c";
    ctx.arc(tip.x, tip.y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
