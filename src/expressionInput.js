/** Only new camera inference results may advance expression confirmation. */
export class ExpressionInput {
  constructor(fsm, maxAgeMs = 250) {
    this.fsm = fsm;
    this.maxAgeMs = maxAgeMs;
    this.lastSampleAt = -Infinity;
    this.lastTickAt = null;
    this.tracking = false;
  }

  invalidate() {
    this.lastSampleAt = -Infinity;
    this.tracking = false;
    this.fsm.update({ found: false }, 0);
  }

  update(sample, now) {
    const dt = this.lastTickAt === null ? 0 : Math.max(0, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    if (sample) {
      // A resumed frame must not count a long stall as neutral calibration time.
      const sampleDt = Number.isFinite(this.lastSampleAt)
        ? Math.min(Math.max(0, (now - this.lastSampleAt) / 1000), 0.1) : 0;
      if (now - this.lastSampleAt >= this.maxAgeMs) this.invalidate();
      this.lastSampleAt = now;
      this.tracking = !!sample.found;
      return this.fsm.update(sample, sampleDt);
    }
    if (now - this.lastSampleAt >= this.maxAgeMs) {
      this.tracking = false;
      return this.fsm.update({ found: false }, dt);
    }
    return { state: this.fsm.state, smile: this.fsm.smile, laugh: this.fsm.laugh,
      burst: false, changed: false };
  }
}
