import { drawContactDebug } from "./onscreenPen.js";

export class DrawingEngine {
  constructor(canvas, options) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.options = options;
    this.guideMode = "horizontal";
    this.strokes = [];
    this.currentStroke = null;
    this.cursor = null;
    this.calibrationTarget = null;
    this.contactDebug = null;
  }

  setContactDebug(debug) {
    this.contactDebug = debug;
    this.redraw();
  }

  setGuideMode(mode) {
    this.guideMode = mode;
    this.redraw();
  }

  setOptions(options) {
    this.options = { ...this.options, ...options };
    this.redraw();
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.redraw();
  }

  clear() {
    this.strokes = [];
    this.currentStroke = null;
    this.redraw();
  }

  beginStroke(point) {
    this.currentStroke = [point];
    this.strokes.push(this.currentStroke);
    this.redraw();
  }

  continueStroke(point) {
    if (!this.currentStroke) {
      this.beginStroke(point);
      return;
    }
    const last = this.currentStroke[this.currentStroke.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (dx * dx + dy * dy < 1) return;
    this.currentStroke.push(point);
    this.redraw();
  }

  endStroke() {
    this.currentStroke = null;
  }

  setCursor(point) {
    this.cursor = point;
    this.redraw();
  }

  setCalibrationTarget(pointOrNull) {
    this.calibrationTarget = pointOrNull;
    this.redraw();
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this.#drawGuide();
    this.#drawCalibrationTarget();

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = this.options.color;
    ctx.lineWidth = this.options.lineWidth;

    for (const stroke of this.strokes) {
      if (stroke.length < 2) {
        if (stroke.length === 1) {
          ctx.beginPath();
          ctx.fillStyle = this.options.color;
          ctx.arc(stroke[0].x, stroke[0].y, this.options.lineWidth / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) {
        ctx.lineTo(stroke[i].x, stroke[i].y);
      }
      ctx.stroke();
    }

    if (this.contactDebug) {
      const { contacts, tip, calibTip, calibAnchor } = this.contactDebug;
      drawContactDebug(ctx, contacts || [], tip, calibTip, calibAnchor);
    }

    if (this.cursor) {
      ctx.beginPath();
      ctx.fillStyle = this.options.cursorColor;
      ctx.arc(this.cursor.x, this.cursor.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.arc(this.cursor.x, this.cursor.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  #drawGuide() {
    const { ctx, canvas, guideMode } = this;
    if (guideMode === "none") return;

    ctx.save();
    ctx.strokeStyle = this.options.guideColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();

    if (guideMode === "horizontal") {
      const y = canvas.height * 0.5;
      ctx.moveTo(canvas.width * 0.08, y);
      ctx.lineTo(canvas.width * 0.92, y);
    } else if (guideMode === "vertical") {
      const x = canvas.width * 0.5;
      ctx.moveTo(x, canvas.height * 0.08);
      ctx.lineTo(x, canvas.height * 0.92);
    } else if (guideMode === "diagonal") {
      ctx.moveTo(canvas.width * 0.12, canvas.height * 0.82);
      ctx.lineTo(canvas.width * 0.88, canvas.height * 0.18);
    }

    ctx.stroke();
    ctx.restore();
  }

  #drawCalibrationTarget() {
    if (!this.calibrationTarget) return;
    const { ctx } = this;
    const { x, y } = this.calibrationTarget;
    ctx.save();
    ctx.strokeStyle = "#0f6b4c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 18, y);
    ctx.lineTo(x + 18, y);
    ctx.moveTo(x, y - 18);
    ctx.lineTo(x, y + 18);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
