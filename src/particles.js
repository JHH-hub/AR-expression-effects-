/**
 * 粒子系统。性能红线下的三条硬约束：
 *   1) 零运行时分配：SoA 结构化数组 + 空闲索引栈，粒子生灭只是整数读写，不产生 GC；
 *   2) 批量绘制：雨滴一次 stroke 画完，火花的拖尾线也是一次 stroke；
 *   3) 预渲染贴图：径向渐变每帧重算会拖垮低端机，改为启动时烘焙 16 张色相 sprite，
 *      运行时只做 drawImage。
 */

import { collideEllipse, sweepEllipse } from './collision.js?v=20261008b';

const GRAVITY = 780;      // px/s²
const DRAG = 0.85;        // 空气阻尼系数
const RESTITUTION = 0.42; // 与头部的弹性系数

/* ---------------- 预渲染 sprite ---------------- */

function buildAtlas(size = 32, hues = 16) {
  const out = [];
  for (let i = 0; i < hues; i++) {
    const h = (i * 360) / hues;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const r = size / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0.0, `hsla(${h}, 100%, 92%, 1)`);
    grd.addColorStop(0.28, `hsla(${h}, 100%, 66%, 0.85)`);
    grd.addColorStop(1.0, `hsla(${h}, 100%, 52%, 0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    out.push(c);
  }
  return out;
}

/* ---------------- 火花池（烟花 + 溅射） ---------------- */

export class SparkPool {
  constructor(cap = 560) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.hue = new Uint8Array(cap);
    this.alive = new Uint8Array(cap);
    this.free = new Int32Array(cap);
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
    this.freeTop = cap;
    this.active = 0;
    this.atlas = buildAtlas();
    this._tmp = { x: 0, y: 0, px: 0, py: 0 };
  }

  spawn(x, y, vx, vy, life, size, hue) {
    if (this.freeTop === 0) return -1; // 池满：直接丢弃，绝不扩容（这是硬预算）
    const i = this.free[--this.freeTop];
    this.x[i] = x; this.y[i] = y;
    this.px[i] = x; this.py[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size; this.hue[i] = hue;
    this.alive[i] = 1;
    this.active++;
    return i;
  }

  /** 烟花爆发：径向速度 + 轻微上偏，模拟真实爆炸的"蘑菇"外形 */
  burst(x, y, count, power = 1) {
    for (let n = 0; n < count; n++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (140 + Math.random() * 380) * power;
      const vx = Math.cos(a) * sp;
      const vy = Math.sin(a) * sp - 90 * power;
      const life = 0.75 + Math.random() * 0.85;
      // 暖色为主：金色/橙红/品红，避免脏掉的灰蓝色
      const hue = Math.random() < 0.72
        ? (Math.random() * 60) | 0
        : (295 + Math.random() * 60) | 0;
      this.spawn(x, y, vx, vy, life, 2.2 + Math.random() * 3.4, ((hue % 360) * 16 / 360) | 0);
    }
  }

  update(dt, ellipse, onHit) {
    const tmp = this._tmp;
    const damp = 1 / (1 + DRAG * dt);
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;

      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        this.free[this.freeTop++] = i;
        this.active--;
        continue;
      }

      this.px[i] = this.x[i];
      this.py[i] = this.y[i];

      let vx = this.vx[i] * damp;
      let vy = (this.vy[i] + GRAVITY * dt) * damp;

      this.x[i] += vx * dt;
      this.y[i] += vy * dt;

      if (sweepEllipse(ellipse, this.px[i], this.py[i], this.x[i], this.y[i], vx, vy, dt, RESTITUTION, tmp)) {
        vx = tmp.x; vy = tmp.y;
        this.x[i] = tmp.px; this.y[i] = tmp.py;
        if (onHit) onHit(this.x[i], this.y[i], this.hue[i]);
      }

      this.vx[i] = vx;
      this.vy[i] = vy;
    }
  }

  draw(ctx) {
    if (this.active === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 拖尾线：全部粒子一次 stroke（单色半透明，配合下面的彩色圆点）
    ctx.beginPath();
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      ctx.moveTo(this.px[i], this.py[i]);
      ctx.lineTo(this.x[i], this.y[i]);
    }
    ctx.strokeStyle = 'rgba(255, 236, 214, 0.20)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 粒子本体
    const atlas = this.atlas;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const t = this.life[i] / this.maxLife[i];
      const a = t > 0.85 ? 1 : Math.pow(t, 0.55);
      const r = this.size[i] * (0.45 + 0.55 * t) * 2.6;
      ctx.globalAlpha = a;
      ctx.drawImage(atlas[this.hue[i]], this.x[i] - r, this.y[i] - r, r * 2, r * 2);
    }

    ctx.restore();
  }

  clear() {
    for (let i = 0; i < this.cap; i++) {
      if (this.alive[i]) { this.alive[i] = 0; this.free[this.freeTop++] = i; }
    }
    this.active = 0;
  }
}

/* ---------------- 雨场 ---------------- */

export class RainField {
  constructor(cap = 300) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.len = new Float32Array(cap);
    this.active = 0;
    this.intensity = 0;
    this._w = 0;
    this._h = 0;
    this._tmp = { x: 0, y: 0, px: 0, py: 0 };
  }

  resize(w, h) {
    this._w = w; this._h = h;
    for (let i = 0; i < this.cap; i++) this._reset(i, true);
  }

  _reset(i, spread) {
    this.x[i] = Math.random() * (this._w || 1);
    this.y[i] = spread ? Math.random() * (this._h || 1) : -20 - Math.random() * (this._h || 1) * 0.5;
    this.vy[i] = 620 + Math.random() * 520;
    this.len[i] = 12 + Math.random() * 22;
  }

  setIntensity(t) {
    const target = Math.round(this.cap * t);
    if (target > this.active) {
      for (let i = this.active; i < target; i++) this._reset(i, true);
    }
    this.active = target;
    this.intensity = t;
  }

  update(dt, ellipse, onHit) {
    if (this.active === 0) return;
    const tmp = this._tmp;
    const h = this._h;
    for (let i = 0; i < this.active; i++) {
      const y = this.y[i] + this.vy[i] * dt;
      // 与头部相交 -> 溅开成水花，而不是穿头而过
      if (collideEllipse(ellipse, this.x[i], y, 0, this.vy[i], 0, tmp)) {
        if (onHit) onHit(this.x[i], y, 9); // hue index 9 ≈ 202°，冷蓝水花
        this._reset(i, false);
        continue;
      }
      if (y > h + 20) { this._reset(i, false); continue; }
      this.y[i] = y;
    }
  }

  draw(ctx) {
    if (this.active === 0) return;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < this.active; i++) {
      const x = this.x[i];
      const y = this.y[i];
      ctx.moveTo(x, y);
      ctx.lineTo(x - 2, y + this.len[i]); // 轻微倾斜，纯垂直线会显得很"贴图"
    }
    ctx.strokeStyle = `rgba(168, 214, 255, ${0.20 + 0.30 * this.intensity})`;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.restore();
  }
}
