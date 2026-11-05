class LowPassFilter {
  constructor() {
    this.hatX = undefined;
  }

  filter(x, alpha) {
    if (this.hatX === undefined) {
      this.hatX = x;
      return x;
    }
    this.hatX = alpha * x + (1 - alpha) * this.hatX;
    return this.hatX;
  }

  reset() {
    this.hatX = undefined;
  }
}

function smoothingFactor(te, cutoff) {
  const r = 2 * Math.PI * cutoff * te;
  return r / (r + 1);
}

class OneEuroFilter1D {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.lastTime = undefined;
  }

  filter(x, timestampMs) {
    if (this.lastTime === undefined) {
      this.lastTime = timestampMs;
      this.xFilter.filter(x, 1);
      this.dxFilter.filter(0, 1);
      return x;
    }

    const te = Math.max((timestampMs - this.lastTime) / 1000, 1e-3);
    this.lastTime = timestampMs;

    const prevX = this.xFilter.hatX ?? x;
    const dx = (x - prevX) / te;
    const edx = this.dxFilter.filter(dx, smoothingFactor(te, this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(x, smoothingFactor(te, cutoff));
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = undefined;
  }

  setParams(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }
}

export class PointSmoother {
  constructor() {
    this.mode = "ema";
    this.emaAlpha = 0.3;
    this.prev = null;
    this.fx = new OneEuroFilter1D(1.0, 0.007, 1.0);
    this.fy = new OneEuroFilter1D(1.0, 0.007, 1.0);
  }

  setMode(mode) {
    if (this.mode !== mode) {
      this.reset();
      this.mode = mode;
    }
  }

  setEmaAlpha(alpha) {
    this.emaAlpha = alpha;
  }

  setOneEuro(params) {
    this.fx.setParams(params.minCutoff, params.beta, params.dCutoff);
    this.fy.setParams(params.minCutoff, params.beta, params.dCutoff);
  }

  reset() {
    this.prev = null;
    this.fx.reset();
    this.fy.reset();
  }

  update(point, timestampMs) {
    if (!point) {
      this.reset();
      return null;
    }

    if (this.mode === "none") {
      this.prev = { ...point };
      return this.prev;
    }

    if (this.mode === "ema") {
      if (!this.prev) {
        this.prev = { ...point };
        return this.prev;
      }
      this.prev = {
        x: this.emaAlpha * point.x + (1 - this.emaAlpha) * this.prev.x,
        y: this.emaAlpha * point.y + (1 - this.emaAlpha) * this.prev.y,
      };
      return this.prev;
    }

    // oneEuro
    return {
      x: this.fx.filter(point.x, timestampMs),
      y: this.fy.filter(point.y, timestampMs),
    };
  }
}
