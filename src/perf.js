/**
 * 帧率 -> 质量档位。
 *
 * 低端机不靠祈祷跑满 60fps，而是主动降级把算力收回来。
 * 滞后阈值（46 降 / 56 升）+ 冷却期，避免在临界点反复横跳造成画质抽搐。
 */

export class PerfMonitor {
  constructor(levels = 3, start = levels - 1) {
    this.levels = levels;
    this.level = start;
    this.fps = 60;
    this._acc = 0;
    this._frames = 0;
    this._cooldown = 2.0;
    this.onLevelChange = null;
  }

  tick(dt) {
    this._acc += dt;
    this._frames++;
    if (this._acc >= 0.5) {
      const measured = this._frames / this._acc;
      this.fps += (measured - this.fps) * 0.6; // EMA 抗瞬时抖动
      this._acc = 0;
      this._frames = 0;
    }
    if (this._cooldown > 0) { this._cooldown -= dt; return; }

    let next = this.level;
    if (this.fps < 46 && this.level > 0) next = this.level - 1;
    else if (this.fps > 56 && this.level < this.levels - 1) next = this.level + 1;

    if (next !== this.level) {
      this.level = next;
      this._cooldown = 2.5;
      if (this.onLevelChange) this.onLevelChange(next);
    }
  }
}
