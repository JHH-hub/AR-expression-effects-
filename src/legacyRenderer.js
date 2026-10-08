/**
 * Canvas 2D 降级渲染器。
 *
 * 仅在 WebGL2 或浮点渲染目标不可用时启用（约占极少数老旧设备）。
 * 与 GLRenderer 保持完全一致的对外接口，因此 main.js 无需任何分支判断。
 * 目标是「功能与交互完整可验收」，画质天花板明显低于 WebGL 路径。
 */

import { SparkPool, RainField } from './particles.js?v=20261008a';

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
  /** Canvas2D 无法做磨皮，仅为接口一致而存在 */
  setBeauty(on) { this.beautyOn = !!on; }

  /**
   * 降级路径的爆发。参数与 GLRenderer.burst 对齐
   * （shell/willow 此处仅用于近似初速缩放，Canvas2D 不做垂柳异质星）。
   */
  burst(x, y, power = 1, ratio = 0.26, shell = 1) {
    const n = Math.round(this.sparks.cap * this.quality.sparkRatio * 0.5 * Math.min(shell, 1.3));
    this.sparks.burst(x, y, Math.max(8, n), power);
  }

  /** 缓慢上浮的光尘，与 WebGL 路径保持同一观感（低初速、宽度随笑张开） */
  stream(x, y, count, width = 70) {
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.1;
      const sp = 14 + Math.random() * 46;
      this.sparks.spawn(
        x + (Math.random() - 0.5) * width, y + (Math.random() - 0.5) * width * 0.35,
        Math.cos(a) * sp, Math.sin(a) * sp,
        0.85 + Math.random() * 0.95, 1.2 + Math.random() * 1.2, 1,
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

    // 摄像头：镜像 + cover（含镜头震动偏移，与 WebGL 路径观感对齐）
    if (this.video && this.video.readyState >= 2) {
      const sc = Math.max(W / this.vw, H / this.vh);
      const dw = this.vw * sc, dh = this.vh * sc;
      const sx = mood.shakeX || 0;
      const sy = mood.shakeY || 0;
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.video, (W - dw) / 2 + sx, (H - dh) / 2 + sy, dw, dh);
      ctx.restore();
      // 摄像头层原样直通，不做任何调色（与 WebGL 路径保持一致）：
      // 特效负责加光，不负责改人。此前叠的暖光会把整幅画面整体提亮而压低对比度。
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
    // 头部辉光环已移除（与 WebGL 路径一致）：椭圆拟合本就比脸大一圈，
    // 描边会显出「歪」；碰撞反馈已由粒子的反弹溅射表达。

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
