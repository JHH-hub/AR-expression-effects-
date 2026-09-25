/**
 * Canvas 2D 降级渲染器。
 *
 * 仅在 WebGL2 或浮点渲染目标不可用时启用（约占极少数老旧设备）。
 * 与 GLRenderer 保持完全一致的对外接口，因此 main.js 无需任何分支判断。
 * 目标是「功能与交互完整可验收」，画质天花板明显低于 WebGL 路径。
 */

import { SparkPool, RainField } from './particles.js';

const LEVELS = [
  { name: 'LOW(2D)',  rain: 90,  sparkRatio: 0.28, dpr: 1.0 },
  { name: 'MID(2D)',  rain: 170, sparkRatio: 0.34, dpr: 1.25 },
  { name: 'HIGH(2D)', rain: 260, sparkRatio: 0.40, dpr: 1.5 },
];

export class LegacyRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Canvas 2D 不可用');
    this.sparks = new SparkPool(700);
    this.rain = new RainField(300);
    this.head = { x: 0, y: 0, rx: 0, ry: 0, valid: false };
    this.rainT = 0;
    this.levelIndex = 2;
    this.W = 1; this.H = 1; this.dpr = 1;
    this.video = null;
    this.vw = 16; this.vh = 9;
    this._splashBudget = 6;
  }

  get quality() { return LEVELS[this.levelIndex]; }

  setQuality(i) { this.levelIndex = Math.max(0, Math.min(LEVELS.length - 1, i)); }

  resize(cssW, cssH) {
    const c = this.canvas;
    this.W = Math.max(1, Math.round(cssW));
    this.H = Math.max(1, Math.round(cssH));
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality.dpr);
    c.width = Math.round(this.W * this.dpr);
    c.height = Math.round(this.H * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.rain.resize(this.W, this.H);
  }

  setHead(e) { this.head = e; }
  setRain(t) { this.rainT = t; }

  burst(x, y, power = 1) {
    this.sparks.burst(x, y, Math.round(this.sparks.cap * this.quality.sparkRatio * 0.5), power);
  }

  stream(x, y, count) {
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const sp = 60 + Math.random() * 170;
      this.sparks.spawn(
        x + (Math.random() - 0.5) * 110, y + (Math.random() - 0.5) * 30,
        Math.cos(a) * sp, Math.sin(a) * sp,
        0.5 + Math.random() * 0.6, 1.6 + Math.random() * 1.6, 1,
      );
    }
  }

  uploadVideo(video) {
    this.video = video;
    if (video && video.videoWidth) { this.vw = video.videoWidth; this.vh = video.videoHeight; }
  }

  render(dt, mood) {
    const ctx = this.ctx;
    const W = this.W, H = this.H;

    // 摄像头：镜像 + cover
    if (this.video && this.video.readyState >= 2) {
      const sc = Math.max(W / this.vw, H / this.vh);
      const dw = this.vw * sc, dh = this.vh * sc;
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.video, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
      ctx.fillStyle = 'rgba(8, 8, 16, 0.26)';  // 压暗，让粒子成为主角
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#07070c';
      ctx.fillRect(0, 0, W, H);
    }

    this._splashBudget = 6;
    const onHit = (x, y, hue) => {
      if (this._splashBudget <= 0) return;
      this._splashBudget--;
      for (let i = 0; i < 2; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
        const sp = 70 + Math.random() * 130;
        this.sparks.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
          0.26 + Math.random() * 0.3, 1.4 + Math.random() * 1.2, hue);
      }
    };

    this.rain.setIntensity(this.rainT * (this.quality.rain / this.rain.cap));
    this.rain.update(dt, this.head, onHit);
    this.sparks.update(dt, this.head, onHit);
    this.rain.draw(ctx);
    this.sparks.draw(ctx);

    // 头部辉光环：碰撞可见性
    const h = this.head;
    if (h.valid && mood.rim > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const warm = mood.warm || 0;
      ctx.strokeStyle = warm > 0.3
        ? `rgba(255, 186, 96, ${0.35 * mood.rim})`
        : `rgba(122, 190, 255, ${0.32 * mood.rim})`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.ellipse(h.x, h.y, h.rx, h.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (mood.flash > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255, 214, 150, ${0.20 * mood.flash})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  stats() {
    return {
      capacity: this.rain.cap + this.sparks.cap,
      active: this.rain.active + this.sparks.active,
      quality: this.quality.name,
    };
  }
}
