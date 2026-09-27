/**
 * 主编排：摄像头 -> 推理 -> 表情状态机 -> 特效指令 -> 渲染。
 *
 * 坐标系唯一真相（最易出 bug 处，集中在此定义）：
 *   摄像头按 cover 铺满画布并水平镜像；所有特效与碰撞体都活在「显示坐标系（CSS 像素）」；
 *   mapX/mapY 是归一化人脸坐标进入显示坐标系的唯一入口，且与合成着色器内的
 *   视频采样映射严格互为逆运算——否则特效会和人脸错位。
 */

import { FaceTracker } from './faceTracker.js';
import { ExpressionFSM, State } from './expressionFSM.js';
import { PerfMonitor } from './perf.js';
import { fitHeadEllipse, createEllipse } from './collision.js';
import { GLRenderer, QUALITY } from './glRenderer.js';
import { LegacyRenderer } from './legacyRenderer.js';
import { UI } from './ui.js';

const video = document.getElementById('cam');
const canvas = document.getElementById('fx');
const stage = document.getElementById('stage');

const ui = new UI();
const tracker = new FaceTracker();
const fsm = new ExpressionFSM();
const perf = new PerfMonitor(3, 2);
const head = createEllipse();

let renderer = null;
let backend = '-';
let W = 1, H = 1;
let drawW = 0, drawH = 0, offX = 0, offY = 0;
let running = false;
let rafId = 0;
let lastTime = 0;
let frame = 0;

let sig = { found: false, smile: 0, jaw: 0, squint: 0, pucker: 0 };
let mouth = { x: 0, y: 0, ok: false };
let hudAcc = 0;

// 待触发的延迟爆发（二段烟花，让爆炸有层次而不是一坨）
const pending = [];

const mood = {
  cool: 0, warm: 0, flash: 0, rim: 0,
  shockX: 0, shockY: 0, shockR: 0, shockLife: 0,
  bloomBoost: 1,
  shakeX: 0, shakeY: 0,
};
let shockT = 999;

/* ---------------- 连击（直播礼物的核心节奏装置） ----------------
 * 直播特效的「排面」来自递进：第 1 发朴素，连击越高越夸张。
 * 单发永远一个样，观感就只是 demo。COMBO_WINDOW 内没有新爆发即清零。
 */
const COMBO_WINDOW = 3.2;
const combo = { n: 0, t: 999, peak: 0 };

/* 镜头震动：礼物触发的体感反馈。用衰减正弦而不是随机抖，避免看着像掉帧 */
const shake = { amp: 0, t: 0, freq: 26 };

function kick(amp) {
  // 取大值而非累加：连点不会把画面抖到失控
  shake.amp = Math.max(shake.amp, Math.min(amp, 26));
  shake.t = 0;
}

/* ---------------- 坐标映射 ---------------- */

const mapX = (nx) => W - offX - nx * drawW;   // 含水平镜像
const mapY = (ny) => offY + ny * drawH;

function recomputeVideoBox() {
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const sc = Math.max(W / vw, H / vh);
  drawW = vw * sc;
  drawH = vh * sc;
  offX = (W - drawW) / 2;
  offY = (H - drawH) / 2;
}

function resize() {
  const rect = stage.getBoundingClientRect();
  W = Math.max(1, Math.round(rect.width));
  H = Math.max(1, Math.round(rect.height));
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  recomputeVideoBox();
  if (renderer) renderer.resize(W, H);
}

/* ---------------- 主循环 ---------------- */

function loop(now) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);

  const dt = Math.min((now - lastTime) / 1000, 0.05); // 卡顿时不让物理炸掉
  lastTime = now;
  frame++;
  perf.tick(dt);

  const q = renderer instanceof GLRenderer ? QUALITY[perf.level] : { detectEvery: perf.level === 0 ? 2 : 1 };

  /* 1) 推理（最大一笔算力开销，按预算隔帧执行） */
  if (frame % (q.detectEvery || 1) === 0) {
    const r = tracker.detect(video);
    if (r) {
      sig = r;
      if (r.found && r.pts) {
        fitHeadEllipse(r.pts, mapX, mapY, head, 0.4);
        // 嘴部略上方作为发射源：视觉上更像「从口中喷出」而非「从下巴冒出」
        mouth.x = mapX(r.anchors.mouth.x);
        mouth.y = mapY(r.anchors.mouth.y) - head.ry * 0.10;
        mouth.ok = true;
      } else {
        head.valid = false;
        mouth.ok = false;
      }
    }
  }

  /* 2) 表情状态机 */
  const st = fsm.update(sig, dt);

  if (fsm.calibrating) {
    ui.showCalibrate(
      fsm.calibrateProgress,
      sig.found ? '请保持自然，不要笑' : '未检测到人脸 · 请正对镜头并确保光线充足',
    );
  } else if (ui.el.calib && !ui.el.calib.classList.contains('hidden')) {
    ui.hideCalibrate();
    ui.toast('校准完成 · 试着笑一下');
  }

  /* 3) 特效指令 */
  const emitX = mouth.ok ? mouth.x : W * 0.5;
  const emitY = mouth.ok ? mouth.y : H * 0.42;

  // 校准期也给环绕金粉：摩擦力归零原则要求「开摄像头即有反馈」，不能空等 1 秒
  if (fsm.calibrating) {
    if (head.valid) {
      const a = now * 0.0021;
      const r = Math.max(head.rx, head.ry) * 1.28;
      renderer.stream(head.x + Math.cos(a) * r, head.y + Math.sin(a) * r * 0.72, 3);
    } else {
      renderer.stream(W * 0.5, H * 0.42, 2);
    }
    renderer.setHead(head);
    renderer.setRain(0);
    updateMood(dt, st);
    renderer.uploadVideo(video);
    renderer.render(dt, mood);
    return;
  }

  if (st.burst) fireFrom(emitX, emitY);

  // 微笑时嘴角持续溢出金色能量流 —— 把「笑」和「特效」在视觉上绑定
  if (st.state === State.SMILE && mouth.ok) {
    const n = Math.round(fsm.smile * 5) + 1;
    renderer.stream(emitX, emitY, n);
  } else {
    renderer.stream(0, 0, 0);
  }

  // 延迟爆发出队
  for (let i = pending.length - 1; i >= 0; i--) {
    pending[i].t -= dt;
    if (pending[i].t <= 0) {
      const b = pending[i];
      renderer.burst(b.x, b.y, b.power, b.ratio);
      pending.splice(i, 1);
    }
  }

  renderer.setHead(head);
  renderer.setRain(fsm.rainIntensity);

  /* 4) 氛围参数 */
  updateMood(dt, st);

  /* 5) 渲染 */
  renderer.uploadVideo(video);
  renderer.render(dt, mood);

  /* 6) HUD（节流） */
  hudAcc += dt;
  if (hudAcc > 0.12) {
    hudAcc = 0;
    ui.setState(st.state);
    ui.setMeters(fsm.smile, fsm.laugh);
    const s = renderer.stats();
    ui.setPerf(perf.fps, s.active, s.capacity, s.quality, tracker.lastInferMs, backend);
    ui.setHype(fsm.smile, fsm.laugh, combo.n);
  }
}

/**
 * 礼物级爆发。
 *
 * 结构参考直播礼物动效的三段式节奏（登场 → 高潮 → 余韵）：
 *   0.00s 主爆（球壳投影，最亮最快）
 *   0.13s 二段余爆（偏移、更小）
 *   0.27s 三段金粉（最慢、最散，负责「余韵」）
 * 规模、闪光、震动都随连击递增，让第 5 发明显比第 1 发有排面。
 */
function fireFrom(x, y) {
  combo.n += 1;
  combo.t = 0;
  if (combo.n > combo.peak) combo.peak = combo.n;

  // 连击增益封顶：再往上粒子会糊成一团光，反而丢失层次
  const c = Math.min(combo.n, 8);
  const gain = 1 + (c - 1) * 0.13;          // 1.00 → 1.91
  const spread = 1 + (c - 1) * 0.10;

  renderer.burst(x, y, 1 * Math.min(gain, 1.55), 0.055 * gain);
  pending.push({
    t: 0.13,
    x: x + (Math.random() - 0.5) * W * 0.30 * spread,
    y: y - H * 0.08,
    power: 0.78, ratio: 0.030 * gain,
  });
  pending.push({
    t: 0.27,
    x: x + (Math.random() - 0.5) * W * 0.42 * spread,
    y: y - H * 0.02,
    power: 0.60, ratio: 0.022 * gain,
  });
  // 连击 ≥3 起追加第三段「金粉余韵」，把节奏从 0.4s 拉长到 0.6s
  if (c >= 3) {
    pending.push({
      t: 0.42,
      x: x + (Math.random() - 0.5) * W * 0.55,
      y: y - H * 0.12,
      power: 0.42, ratio: 0.018 * gain,
    });
  }

  mood.flash = Math.min(1.35, 1 + (c - 1) * 0.05);
  shockT = 0;
  mood.shockX = x;
  mood.shockY = y;
  kick(7 + c * 2.2);

  ui.showGift(combo.n);
}

function updateMood(dt, st) {
  const kSlow = 1 - Math.pow(0.5, dt / 0.22);
  const targetCool = st.state === State.NEUTRAL ? 0 : fsm.rainIntensity;
  mood.cool += (targetCool - mood.cool) * kSlow;
  mood.warm += (fsm.laugh - mood.warm) * kSlow;

  /* 连击窗口与震动衰减 */
  combo.t += dt;
  if (combo.n > 0 && combo.t > COMBO_WINDOW) {
    combo.n = 0;
    ui.hideGift();
  }

  if (shake.amp > 0.05) {
    shake.t += dt;
    const decay = Math.exp(-shake.t * 7.5);
    const env = shake.amp * decay;
    mood.shakeX = Math.sin(shake.t * shake.freq * 6.283) * env;
    mood.shakeY = Math.cos(shake.t * shake.freq * 4.7 + 1.1) * env * 0.62;
    if (env < 0.05) { shake.amp = 0; mood.shakeX = 0; mood.shakeY = 0; }
  } else {
    mood.shakeX = 0;
    mood.shakeY = 0;
  }

  // 辉光环只在有特效时亮起，中性状态保持干净
  const targetRim = Math.min(1.25, fsm.rainIntensity * 0.42 + fsm.laugh * 0.95);
  mood.rim += (targetRim - mood.rim) * kSlow;

  mood.flash *= Math.pow(0.015, dt);      // ~0.2s 内衰减干净
  if (mood.flash < 0.002) mood.flash = 0;

  shockT += dt;
  if (shockT < 0.62) {
    mood.shockR = shockT * 980;
    mood.shockLife = Math.pow(1 - shockT / 0.62, 1.6);
  } else {
    mood.shockLife = 0;
  }

  // 连击也吃进 bloom：越高连击画面整体越「烧」，这是礼物排面的关键一环
  const comboBoost = Math.min(combo.n, 8) * 0.045;
  mood.bloomBoost = 1 + fsm.laugh * 0.35 + (combo.n > 0 ? comboBoost : 0);
}

/* ---------------- 启动 ---------------- */

function pickRenderer() {
  const probe = GLRenderer.probe();
  if (probe.ok) {
    try {
      const r = new GLRenderer(canvas);
      r.setQuality(2);
      backend = 'WebGL2 · GPU 粒子';
      return r;
    } catch (e) {
      console.warn('[renderer] WebGL2 初始化失败，降级 Canvas2D：', e);
    }
  } else {
    console.warn('[renderer] 降级原因：', probe.reason);
  }
  const r = new LegacyRenderer(canvas);
  r.setQuality(2);
  backend = 'Canvas2D · 降级模式';
  return r;
}

async function boot() {
  if (!window.isSecureContext) {
    ui.setGateError('当前不是安全上下文（HTTPS / localhost），浏览器会拒绝摄像头权限。请通过 https 链接访问。');
    return;
  }

  try {
    ui.setGateBusy('正在请求摄像头…');
    await tracker.start(video);
  } catch (e) {
    const name = (e && e.name) || String(e);
    const hint = name === 'NotAllowedError'
      ? '权限被拒绝。请在地址栏的站点设置中允许摄像头后重试。'
      : name === 'NotFoundError'
        ? '没有检测到可用摄像头。'
        : `摄像头打开失败（${name}）。`;
    ui.setGateError(hint);
    return;
  }

  try {
    ui.setGateBusy('正在加载人脸模型…');
    await tracker.load();
  } catch (e) {
    ui.setGateError(`人脸模型加载失败：${e}。模型来自 CDN，请检查网络后重试。`);
    return;
  }

  try {
    ui.setGateBusy('正在初始化渲染器…');
    renderer = pickRenderer();
  } catch (e) {
    ui.setGateError(`渲染器初始化失败：${e}`);
    return;
  }

  perf.onLevelChange = (lv) => {
    renderer.setQuality(lv);
    renderer.resize(W, H);
    ui.toast(`画质已自动调整为 ${renderer.stats().quality}`);
  };

  recomputeVideoBox();
  resize();
  ui.hideGate();
  if (backend.startsWith('Canvas2D')) {
    ui.toast('设备不支持 WebGL2 浮点渲染，已切换到降级模式', 4000);
  }

  running = true;
  lastTime = performance.now();
  rafId = requestAnimationFrame(loop);
}

/* ---------------- 事件 ---------------- */

ui.bind({
  onStart: boot,
  onBurst: () => fireFrom(mouth.ok ? mouth.x : W * 0.5, mouth.ok ? mouth.y : H * 0.4),
  onBeauty: (on) => {
    // 默认关。开启后给一档温和强度：仅柔化明暗差小的区域（皮肤），
    // 边缘保护会让眼睛/嘴唇/发丝保持锐利，避免整幅画面一起被糊。
    mood.beauty = on ? (perf.level === 0 ? 0.25 : 0.42) : 0;
    renderer.setBeauty(on);
    ui.toast(on ? '美颜已开启（轻）' : '美颜已关闭 · 摄像头原样');
  },
  onRecalibrate: () => { fsm.reset(); ui.toast('请保持自然表情 1 秒…'); },
});

window.addEventListener('resize', resize);
if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
video.addEventListener('loadedmetadata', () => { recomputeVideoBox(); resize(); });

// 切到后台彻底停机：不推理、不模拟、不渲染
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    running = false;
    cancelAnimationFrame(rafId);
    video.pause();
  } else if (renderer) {
    video.play().catch(() => {});
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }
});

resize();

// 调试钩子：便于真机排查与自动化验证，不带来运行时开销
window.__ar = {
  get renderer() { return renderer; },
  get head() { return head; },
  get backend() { return backend; },
  get combo() { return combo.n; },
  get comboPeak() { return combo.peak; },
  fire: (n = 1) => { for (let i = 0; i < n; i++) fireFrom(W * 0.5, H * 0.42); },
  fsm, tracker, perf, mood, ui,
};
