/**
 * WebGL2 渲染器。
 *
 * 性能核心：粒子物理 100% 在 GPU（ping-pong 浮点纹理 + MRT）。
 * CPU 每帧只上传约 10 个 uniform 与 1 张摄像头纹理，
 * 粒子数量从 Canvas2D 时代的数百级提升到 6 万级，而主线程开销几乎不变。
 *
 * 绘制调用：模拟 1 次 + 雨 1 次 + 火花 1 次 + 辉光 5 次 + 合成 1 次 = 每帧 9 次。
 */

import {
  QUAD_VS, SIMULATE_FS,
  SPARK_VS, SPARK_FS,
  SPARK_TRAIL_VS, SPARK_TRAIL_FS,
  RAIN_VS, RAIN_FS,
  BRIGHT_FS, BLUR_FS, COMPOSITE_FS,
} from './shaders.js';

/* ---------------- 底层小工具 ---------------- */

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  // 预取 uniform/attribute 位置，避免每帧字符串查找
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  const a = {};
  const m = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < m; i++) {
    const info = gl.getActiveAttrib(p, i);
    a[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { p, u, a };
}

function makeTex(gl, w, h, internal, format, type, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function makeFbo(gl, textures) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  const bufs = [];
  textures.forEach((t, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  if (bufs.length > 1) gl.drawBuffers(bufs);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) throw new Error('framebuffer incomplete');
  return f;
}

/* ---------------- 质量档位 ---------------- */
// texSize² = 粒子容量。rainRatio 决定雨与火花的槽位切分。
// beauty：可选美颜强度，**默认全档为 0（关闭）**。
//   实测：磨皮 + 提亮 + 暖肤 + 增饱和 + 柔光叠加这套组合会把中间调整体抬高约 0.21、
//   压低对比度，人脸呈「灰蒙发糊」的塑料感；短视频平台的美颜之所以自然，
//   是因为它基于皮肤分割做了局部处理，而 5-tap 均值磨皮无法区分皮肤与背景，
//   结果是整幅画面一起被糊。因此默认直通摄像头，需要时再手动开。
export const QUALITY = [
  { name: 'LOW',  texSize: 96,  rainRatio: 0.090, dpr: 1.0,  bloom: 1.05, detectEvery: 2, beauty: 0.00 },
  { name: 'MID',  texSize: 160, rainRatio: 0.080, dpr: 1.25, bloom: 1.15, detectEvery: 1, beauty: 0.00 },
  { name: 'HIGH', texSize: 256, rainRatio: 0.075, dpr: 1.5,  bloom: 1.25, detectEvery: 1, beauty: 0.00 },
];

export class GLRenderer {
  static probe() {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { antialias: false });
    if (!gl) return { ok: false, reason: 'WebGL2 不可用' };
    const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
    // 浏览器同时存活的 WebGL context 数量有限，探测用的必须立刻释放
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    if (!hasFloat) {
      return { ok: false, reason: '不支持浮点渲染目标（EXT_color_buffer_float）' };
    }
    return { ok: true, reason: '' };
  }

  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!this.gl) throw new Error('WebGL2 不可用');
    const gl = this.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('不支持浮点渲染目标');
    }
    gl.getExtension('OES_texture_float_linear');

    this.W = 1; this.H = 1; this.dpr = 1;
    this.pw = 0; this.ph = 0;          // 像素尺寸
    this.qualityIndex = 2;
    this.texSize = 0;
    this.rainSlots = 0;
    this.sparkCap = 0;
    this.sparkCursor = 0;
    this.sparkActiveHi = 0;             // 活跃火花高水位：绘制只覆盖 [0, hi)，空闲时趋近 0
    this.time = 0;
    this.src = 0;                       // ping-pong 游标

    this.head = { x: 0, y: 0, rx: 0, ry: 0, valid: false };
    this.rainIntensity = 0;
    // 美颜默认关闭。LOW 档没有余量开，MID/HIGH 开了也只在明暗差小的区域生效。
    this.beautyOn = false;
    this.estRain = 0;
    this.estSpark = 0;

    this._burst = { x: 0, y: 0, power: 0, seed: 0, start: 0, count: 0, shell: 1, willow: 0.30 };
    this._stream = { x: 0, y: 0, width: 70, seed: 0, start: 0, count: 0 };

    this.contextLost = false;

    // WebGL context 丢失恢复：切换 GPU、显卡驱动复位、移动端后台回收都会触发。
    // 不处理则画面永久黑屏且静默无报错。丢失时暂停绘制，恢复时重建全部 GL 资源。
    this._onLost = (e) => {
      e.preventDefault();          // 必须阻止默认行为，否则浏览器不会派发 restored
      this.contextLost = true;
    };
    this._onRestored = () => {
      this.contextLost = false;
      this._buildPrograms();
      this._buildQuad();
      this._buildVideoTex();
      const qi = this.qualityIndex;
      this.texSize = 0;            // 强制 setQuality 走完整重建分支
      this.states = null;
      this.setQuality(qi);
      const pw = this.pw, ph = this.ph;
      this.pw = 0; this.ph = 0;    // 强制 resize 重建场景/辉光 FBO
      this.resize(this.W, this.H);
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    this._buildPrograms();
    this._buildQuad();
    this._buildVideoTex();
  }

  /* ---------------- 构建 ---------------- */

  _buildPrograms() {
    const gl = this.gl;
    this.pSim = program(gl, QUAD_VS, SIMULATE_FS);
    this.pSpark = program(gl, SPARK_VS, SPARK_FS);
    this.pTrail = program(gl, SPARK_TRAIL_VS, SPARK_TRAIL_FS);
    this.pRain = program(gl, RAIN_VS, RAIN_FS);
    this.pBright = program(gl, QUAD_VS, BRIGHT_FS);
    this.pBlur = program(gl, QUAD_VS, BLUR_FS);
    this.pComp = program(gl, QUAD_VS, COMPOSITE_FS);
  }

  _buildQuad() {
    const gl = this.gl;
    this.quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // 覆盖全屏的大三角
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _buildVideoTex() {
    const gl = this.gl;
    this.videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([10, 10, 16, 255]));
    this.videoReady = false;
  }

  /** 切换美颜（默认关）。开启后由 main.js 每帧下传强度，见 QUALITY 注释。 */
  setBeauty(on) { this.beautyOn = !!on; }

  /** 重建粒子状态纹理与索引缓冲（质量切换时调用） */
  setQuality(index) {
    const gl = this.gl;
    const q = QUALITY[Math.max(0, Math.min(QUALITY.length - 1, index))];
    if (this.texSize === q.texSize && this.states) { this.qualityIndex = index; return; }
    this.qualityIndex = index;
    this.texSize = q.texSize;

    const total = q.texSize * q.texSize;
    this.rainSlots = Math.floor(total * q.rainRatio);
    this.sparkCap = total - this.rainSlots;
    this.sparkCursor = 0;
    this.sparkActiveHi = 0;   // 纹理重建后所有粒子归零，高水位随之复位

    if (this.states) {
      this.states.forEach((s) => {
        gl.deleteTexture(s.t0);
        gl.deleteTexture(s.t1);
        gl.deleteFramebuffer(s.fbo);
      });
    }

    const mk = () => {
      const t0 = makeTex(gl, q.texSize, q.texSize, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
      const t1 = makeTex(gl, q.texSize, q.texSize, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
      const fbo = makeFbo(gl, [t0, t1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, q.texSize, q.texSize);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);   // life = 0 => 全部死亡，等待 spawn
      return { t0, t1, fbo };
    };
    this.states = [mk(), mk()];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.src = 0;

    // 火花：每粒子 1 个 POINT
    if (this.sparkVbo) gl.deleteBuffer(this.sparkVbo);
    const sIdx = new Float32Array(this.sparkCap);
    for (let i = 0; i < this.sparkCap; i++) sIdx[i] = i;
    this.sparkVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
    gl.bufferData(gl.ARRAY_BUFFER, sIdx, gl.STATIC_DRAW);
    if (this.sparkVao) gl.deleteVertexArray(this.sparkVao);
    this.sparkVao = gl.createVertexArray();
    gl.bindVertexArray(this.sparkVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
    // 所有粒子着色器都用 layout(location = 0)，避免依赖链接器分配顺序
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);

    // 火花拖尾：每粒子 2 个顶点（线段）
    if (this.trailVbo) gl.deleteBuffer(this.trailVbo);
    const tVerts = new Float32Array(this.sparkCap * 4);
    for (let i = 0; i < this.sparkCap; i++) {
      tVerts[i * 4 + 0] = i; tVerts[i * 4 + 1] = 0;
      tVerts[i * 4 + 2] = i; tVerts[i * 4 + 3] = 1;
    }
    this.trailVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailVbo);
    gl.bufferData(gl.ARRAY_BUFFER, tVerts, gl.STATIC_DRAW);
    if (this.trailVao) gl.deleteVertexArray(this.trailVao);
    this.trailVao = gl.createVertexArray();
    gl.bindVertexArray(this.trailVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 雨：每粒子 2 个顶点（线段）
    if (this.rainVbo) gl.deleteBuffer(this.rainVbo);
    const rVerts = new Float32Array(this.rainSlots * 4);
    for (let i = 0; i < this.rainSlots; i++) {
      rVerts[i * 4 + 0] = i; rVerts[i * 4 + 1] = 0;
      rVerts[i * 4 + 2] = i; rVerts[i * 4 + 3] = 1;
    }
    this.rainVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rainVbo);
    gl.bufferData(gl.ARRAY_BUFFER, rVerts, gl.STATIC_DRAW);
    if (this.rainVao) gl.deleteVertexArray(this.rainVao);
    this.rainVao = gl.createVertexArray();
    gl.bindVertexArray(this.rainVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rainVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  get quality() { return QUALITY[this.qualityIndex]; }

  resize(cssW, cssH) {
    const gl = this.gl;
    const q = this.quality;
    this.W = Math.max(1, Math.round(cssW));
    this.H = Math.max(1, Math.round(cssH));
    this.dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    const pw = Math.max(1, Math.round(this.W * this.dpr));
    const ph = Math.max(1, Math.round(this.H * this.dpr));
    if (pw === this.pw && ph === this.ph && this.sceneFbo) return;
    this.pw = pw; this.ph = ph;
    this.canvas.width = pw;
    this.canvas.height = ph;

    const del = (t) => t && gl.deleteTexture(t);
    const delf = (f) => f && gl.deleteFramebuffer(f);
    del(this.sceneTex); delf(this.sceneFbo);
    [this.h0a, this.h0b, this.h1a, this.h1b].forEach(del);
    [this.f0a, this.f0b, this.f1a, this.f1b].forEach(delf);

    const F = (w, h) => makeTex(gl, w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    this.sceneTex = F(pw, ph);
    this.sceneFbo = makeFbo(gl, [this.sceneTex]);

    this.bw = Math.max(1, pw >> 2);  this.bh = Math.max(1, ph >> 2);
    this.cw = Math.max(1, pw >> 4);  this.ch = Math.max(1, ph >> 4);
    this.h0a = F(this.bw, this.bh); this.f0a = makeFbo(gl, [this.h0a]);
    this.h0b = F(this.bw, this.bh); this.f0b = makeFbo(gl, [this.h0b]);
    this.h1a = F(this.cw, this.ch); this.f1a = makeFbo(gl, [this.h1a]);
    this.h1b = F(this.cw, this.ch); this.f1b = makeFbo(gl, [this.h1b]);
  }

  /* ---------------- 外部输入 ---------------- */

  setHead(e) { this.head = e; }
  setRain(t) { this.rainIntensity = Math.max(0, Math.min(1, t)); }

  /**
   * 烟花爆发。
   *
   * @param x,y    爆发中心（显示像素）。应为画面上的一个点，不再绑定嘴部 ——
   *               真实烟花的观感前提是「在空旷处炸开」，从嘴这种局部位置喷出来
   *               会读成「吐东西」而不是烟花。
   * @param power  力度倍率
   * @param ratio  本次占用池子比例
   * @param shell  球壳初速倍率，决定烟火半径（1 约覆盖半个屏高）
   * @param willow 垂柳星占比，注入花型异质性
   */
  burst(x, y, power = 1, ratio = 0.26, shell = 1, willow = 0.30) {
    const count = Math.max(1, Math.round(this.sparkCap * ratio));
    this._burst.x = x; this._burst.y = y;
    this._burst.power = power;
    this._burst.seed = Math.random() * 1000;
    this._burst.start = this.sparkCursor;
    this._burst.count = count;
    this._burst.shell = shell;
    this._burst.willow = willow;
    this.sparkCursor = (this.sparkCursor + count) % this.sparkCap;
    this.estSpark = Math.min(this.sparkCap, this.estSpark + count);
    // 记录本次写入触及的最高槽位（可能环绕，故取整池上界）
    this._bumpSparkHi(this._burst.start, count);
  }

  /**
   * 持续光尘：微笑时缓慢上浮的金色微尘，宽度随笑的程度张开。
   *
   * 刻意不做成「定向喷射」—— 旧版给了 60~230 px/s 的初速，视觉上像漏气。
   * @param width 横向展开宽度（像素），让光尘覆盖面部宽度而不是聚成一点
   */
  stream(x, y, count, width = 70) {
    const n = Math.max(0, Math.round(count));
    this._stream.x = x; this._stream.y = y;
    this._stream.width = width;
    this._stream.seed = Math.random() * 1000;
    this._stream.start = this.sparkCursor;
    this._stream.count = n;
    if (n > 0) {
      this.sparkCursor = (this.sparkCursor + n) % this.sparkCap;
      this.estSpark = Math.min(this.sparkCap, this.estSpark + n);
      this._bumpSparkHi(this._stream.start, n);
    }
  }

  /**
   * 抬高火花活跃高水位。写入区间若环绕（start+count 越界）说明全池都可能有活跃粒子，
   * 直接顶到 sparkCap；否则记录到本次写入的末端槽位。绘制时据此裁剪顶点数量，
   * 空闲期不再对整池 6 万粒子执行顶点着色器（省下几乎全部无效的裁剪剔除）。
   */
  _bumpSparkHi(start, count) {
    const end = start + count;
    const hi = end > this.sparkCap ? this.sparkCap : end;
    if (hi > this.sparkActiveHi) this.sparkActiveHi = hi;
  }

  uploadVideo(video) {
    if (this.contextLost || !video || video.readyState < 2) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    // 翻转成「v=1 对应画面顶部」，与屏幕 UV 及粒子坐标系保持同向
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.videoReady = true;
    this.vw = video.videoWidth || 16;
    this.vh = video.videoHeight || 9;
  }

  /* ---------------- 每帧 ---------------- */

  render(dt, mood) {
    if (this.contextLost || !this.states || !this.sceneFbo) return;
    const gl = this.gl;
    // 取模防止长时间运行后 highp float 精度退化，导致 shader 内 hash 失真
    this.time = (this.time + dt) % 600;

    this._simulate(dt);
    this._drawParticles();
    this._bloom();
    this._composite(mood);

    // 清掉一次性的 spawn 指令，避免下一帧重复注入
    this._burst.count = 0;
    this._stream.count = 0;

    // 估算活跃数（GPU 回读代价高，这里只为 HUD 展示）
    this.estRain = Math.round(this.rainSlots * this.rainIntensity);
    this.estSpark *= Math.pow(0.35, dt);

    // 活跃高水位随时间回落。现在最长寿的粒子是光尘（maxLife 上限 2.30s），
    // 用 2.8s 兜底，之后无新爆发即归零，绘制彻底跳过空闲槽位。
    if (this.estSpark < 0.5) {
      this._sparkIdle = (this._sparkIdle || 0) + dt;
      if (this._sparkIdle > 2.8) this.sparkActiveHi = 0;
    } else {
      this._sparkIdle = 0;
    }
  }

  _simulate(dt) {
    const gl = this.gl;
    const { p, u } = this.pSim;
    const s = this.states[this.src];
    const d = this.states[1 - this.src];

    gl.bindFramebuffer(gl.FRAMEBUFFER, d.fbo);
    gl.viewport(0, 0, this.texSize, this.texSize);
    gl.disable(gl.BLEND);
    gl.useProgram(p);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, s.t0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, s.t1);
    gl.uniform1i(u.uState0, 0);
    gl.uniform1i(u.uState1, 1);
    gl.uniform2f(u.uTexSize, this.texSize, this.texSize);
    gl.uniform2f(u.uScreen, this.W, this.H);
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uTime, this.time);
    // 物理尺度跟着屏幕短边走：花型在不同设备上保持同一视觉比例。
    // 以 390×844 手机竖屏（短边 390）为基准，此时系数≈1，与标定数值一致。
    gl.uniform1f(u.uPhysScale, Math.max(Math.min(this.W, this.H), 1) / 390);

    const h = this.head;
    gl.uniform4f(u.uHead, h.x, h.y, Math.max(h.rx, 1), Math.max(h.ry, 1));
    gl.uniform1f(u.uHeadValid, h.valid ? 1 : 0);
    gl.uniform1i(u.uRainSlots, this.rainSlots);
    gl.uniform1f(u.uRainIntensity, this.rainIntensity);

    const b = this._burst;
    gl.uniform4f(u.uBurst, b.x, b.y, b.power, b.seed);
    gl.uniform2i(u.uBurstSlot, b.start, b.count);
    gl.uniform2f(u.uShell, b.shell, b.willow);
    const st = this._stream;
    gl.uniform4f(u.uStream, st.x, st.y, st.width, st.seed);
    gl.uniform2i(u.uStreamSlot, st.start, st.count);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.src = 1 - this.src;
  }

  _drawParticles() {
    const gl = this.gl;
    const s = this.states[this.src];

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.pw, this.ph);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);   // 加性：粒子越密越亮，是辉光的前提

    const h = this.head;
    const hv = h.valid ? 1 : 0;

    // 雨
    {
      const { p, u } = this.pRain;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, s.t0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, s.t1);
      gl.uniform1i(u.uState0, 0);
      gl.uniform1i(u.uState1, 1);
      gl.uniform2f(u.uTexSize, this.texSize, this.texSize);
      gl.uniform2f(u.uScreen, this.W, this.H);
      gl.uniform4f(u.uHead, h.x, h.y, Math.max(h.rx, 1), Math.max(h.ry, 1));
      gl.uniform1f(u.uHeadValid, hv);
      gl.bindVertexArray(this.rainVao);
      gl.drawArrays(gl.LINES, 0, this.rainSlots * 2);
    }

    // 只绘制活跃高水位内的火花，空闲期该值为 0，整段直接跳过
    const sparkDraw = this.sparkActiveHi;

    // 火花拖尾（先画，让亮芯叠在上层）
    if (sparkDraw > 0) {
      const { p, u } = this.pTrail;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, s.t0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, s.t1);
      gl.uniform1i(u.uState0, 0);
      gl.uniform1i(u.uState1, 1);
      gl.uniform2f(u.uTexSize, this.texSize, this.texSize);
      gl.uniform2f(u.uScreen, this.W, this.H);
      gl.uniform1i(u.uRainSlots, this.rainSlots);
      gl.bindVertexArray(this.trailVao);
      gl.drawArrays(gl.LINES, 0, sparkDraw * 2);
    }

    // 火花亮芯
    if (sparkDraw > 0) {
      const { p, u } = this.pSpark;
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, s.t0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, s.t1);
      gl.uniform1i(u.uState0, 0);
      gl.uniform1i(u.uState1, 1);
      gl.uniform2f(u.uTexSize, this.texSize, this.texSize);
      gl.uniform2f(u.uScreen, this.W, this.H);
      gl.uniform1i(u.uRainSlots, this.rainSlots);
      gl.uniform1f(u.uPointScale, this.dpr);
      gl.uniform1f(u.uTime, this.time);
      gl.uniform4f(u.uHead, h.x, h.y, Math.max(h.rx, 1), Math.max(h.ry, 1));
      gl.uniform1f(u.uHeadValid, hv);
      gl.bindVertexArray(this.sparkVao);
      gl.drawArrays(gl.POINTS, 0, sparkDraw);
    }

    gl.disable(gl.BLEND);
  }

  _blurPass(srcTex, dstFbo, w, h, dx, dy) {
    const gl = this.gl;
    const { p, u } = this.pBlur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uDir, dx, dy);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _bloom() {
    const gl = this.gl;
    // 亮度提取 + 1/4 降采样
    {
      const { p, u } = this.pBright;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.f0a);
      gl.viewport(0, 0, this.bw, this.bh);
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
      gl.uniform1i(u.uScene, 0);
      gl.uniform1f(u.uThreshold, 0.58);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // 近场辉光
    this._blurPass(this.h0a, this.f0b, this.bw, this.bh, 1 / this.bw, 0);
    this._blurPass(this.h0b, this.f0a, this.bw, this.bh, 0, 1 / this.bh);
    // 远场辉光（1/16，大半径柔光）
    this._blurPass(this.h0a, this.f1a, this.cw, this.ch, 1 / this.cw, 0);
    this._blurPass(this.h1a, this.f1b, this.cw, this.ch, 0, 1 / this.ch);
    this._blurPass(this.h1b, this.f1a, this.cw, this.ch, 1.6 / this.cw, 0);
  }

  _composite(mood) {
    const gl = this.gl;
    const { p, u } = this.pComp;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.pw, this.ph);
    gl.disable(gl.BLEND);
    gl.useProgram(p);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.h0a);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.h1a);
    gl.uniform1i(u.uVideo, 0);
    gl.uniform1i(u.uScene, 1);
    gl.uniform1i(u.uBloom0, 2);
    gl.uniform1i(u.uBloom1, 3);

    // cover 映射：把视频按短边铺满，长边居中裁切
    const vw = this.vw || 16, vh = this.vh || 9;
    const sc = Math.max(this.W / vw, this.H / vh);
    const dw = (vw * sc) / this.W;
    const dh = (vh * sc) / this.H;
    gl.uniform2f(u.uVideoScale, dw, dh);
    gl.uniform2f(u.uVideoOffset, (1 - dw) / 2, (1 - dh) / 2);
    gl.uniform2f(u.uScreen, this.W, this.H);
    gl.uniform1f(u.uBloomStrength, this.quality.bloom * (mood.bloomBoost || 1));
    // 震动在 uv 空间做偏移：不改 canvas 尺寸也不触发 layout，零重排开销
    gl.uniform2f(u.uShake, (mood.shakeX || 0) / this.W, (mood.shakeY || 0) / this.H);
    gl.uniform1f(u.uBeauty, this.beautyOn ? (mood.beauty || 0) : 0);
    gl.uniform2f(u.uTexel, 1 / vw, 1 / vh);

    const h = this.head;
    gl.uniform4f(u.uHead, h.x, h.y, Math.max(h.rx, 1), Math.max(h.ry, 1));
    gl.uniform1f(u.uHeadValid, h.valid ? 1 : 0);
    gl.uniform1f(u.uRim, mood.rim || 0);
    gl.uniform1f(u.uMoodCool, mood.cool || 0);
    gl.uniform1f(u.uMoodWarm, mood.warm || 0);
    gl.uniform1f(u.uFlash, mood.flash || 0);
    gl.uniform3f(u.uShock, mood.shockX || 0, mood.shockY || 0, mood.shockR || 0);
    gl.uniform1f(u.uShockLife, mood.shockLife || 0);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  stats() {
    return {
      capacity: this.texSize * this.texSize,
      active: Math.round(this.estRain + this.estSpark),
      quality: this.quality.name,
    };
  }
}
