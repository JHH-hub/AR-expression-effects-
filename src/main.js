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
};
let shockT = 999;

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
  }
}

function fireFrom(x, y) {
  // 单发约 3 千粒子：球壳投影下这个量级已足够华丽，再多只会糊成光团
  renderer.burst(x, y, 1, 0.055);
  // 二段余爆：更小、更晚、稍偏移，形成层次而不是一坨
  pending.push({ t: 0.13, x: x + (Math.random() - 0.5) * W * 0.30, y: y - H * 0.08, power: 0.78, ratio: 0.030 });
  pending.push({ t: 0.27, x: x + (Math.random() - 0.5) * W * 0.42, y: y - H * 0.02, power: 0.60, ratio: 0.022 });
  mood.flash = 1;
  shockT = 0;
  mood.shockX = x;
  mood.shockY = y;
}

function updateMood(dt, st) {
  const kSlow = 1 - Math.pow(0.5, dt / 0.22);
  const targetCool = st.state === State.NEUTRAL ? 0 : fsm.rainIntensity;
  mood.cool += (targetCool - mood.cool) * kSlow;
  mood.warm += (fsm.laugh - mood.warm) * kSlow;

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

  mood.bloomBoost = 1 + fsm.laugh * 0.35;
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
  fsm, tracker, perf, mood,
};
