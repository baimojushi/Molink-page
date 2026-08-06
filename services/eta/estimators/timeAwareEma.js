'use strict';

class TimeAwareEma {
  constructor(maxWindowMs) {
    this.maxWindowMs = Math.max(1, Number(maxWindowMs) || 1);
    this.windowMs = 0;
    this.mean = null;
    this.meanSquare = null;
  }

  add(value, elapsedMs) {
    if (!Number.isFinite(value) || value < 0) return false;
    const dt = Math.max(1, Number(elapsedMs) || 1);
    this.windowMs = Math.min(this.maxWindowMs, this.windowMs + dt);
    const alpha = Math.min(1, dt / Math.max(1, this.windowMs));
    if (this.mean === null) {
      this.mean = value;
      this.meanSquare = value * value;
      return true;
    }
    this.mean += alpha * (value - this.mean);
    this.meanSquare += alpha * (value * value - this.meanSquare);
    return true;
  }

  get variance() {
    if (this.mean === null) return null;
    return Math.max(0, this.meanSquare - this.mean * this.mean);
  }

  get stddev() {
    return this.variance === null ? null : Math.sqrt(this.variance);
  }
}

module.exports = { TimeAwareEma };
