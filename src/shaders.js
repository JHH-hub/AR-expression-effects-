/**
 * GLSL ES 3.00 着色器集。
 *
 * 渲染管线（每帧）：
 *   1. simulate  : ping-pong FBO 内更新全部粒子（位置/速度/寿命/碰撞），CPU 零参与
 *   2. rain/spark: 粒子绘制到 HDR 场景缓冲（RGBA16F，加性混合）
 *   3. bright    : 亮度提取并降采样 1/4
 *   4. blur x N  : 可分离高斯（横+竖），形成多级辉光
 *   5. composite : 摄像头原样 + 背景分离 + 场景 + 辉光 + 头部辉光环 + 冲击波 + 暗角
 *
 * 粒子状态打包在两张浮点纹理：
 *   state0 = (pos.x, pos.y, vel.x, vel.y)
 *   state1 = (life, maxLife, hue01, seed)
 * 粒子类型由槽位区间决定（前 uRainSlots 个是雨，其余是火花），不占存储通道。
 */

/* ============================ 公共 ============================ */

export const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HASH = `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec2 hash21(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}`;

/** 礼物色板：白金 → 琥珀 → 品红。刻意避开灰蓝，让高光始终「贵」。 */
const PALETTE = `
vec3 giftPalette(float t) {
  vec3 hot     = vec3(1.00, 0.97, 0.88); // 芯部白金
  vec3 gold    = vec3(1.00, 0.78, 0.36);
  vec3 amber   = vec3(1.00, 0.48, 0.16);
  vec3 magenta = vec3(1.00, 0.24, 0.58);
  // 白金段刻意压窄：段宽相等会让大半粒子发白，丢掉礼物色
  if (t < 0.18) return mix(hot, gold, t / 0.18);
  if (t < 0.58) return mix(gold, amber, (t - 0.18) / 0.40);
  return mix(amber, magenta, (t - 0.58) / 0.42);
}
vec3 rainColor(float t) {
  return mix(vec3(0.40, 0.66, 1.00), vec3(0.74, 0.90, 1.00), t);
}`;

/** 椭圆归一化距离：<1 在头内。全管线共用同一份定义，避免 CPU/GPU 判定漂移。 */
const ELLIPSE = `
float headDist(vec2 p, vec4 head) {
  vec2 d = (p - head.xy) / max(head.zw, vec2(1.0));
  return length(d);
}`;

/* ============================ 1. 粒子模拟 ============================ */

export const SIMULATE_FS = `#version 300 es
precision highp float;

uniform sampler2D uState0;
uniform sampler2D uState1;
uniform vec2  uTexSize;
uniform vec2  uScreen;
uniform float uDt;
uniform float uTime;

uniform vec4  uHead;        // x, y, rx, ry (显示像素)
uniform float uHeadValid;

uniform int   uRainSlots;
uniform float uRainIntensity;

// 爆发源（大笑烟花）：xy=中心, z=power, w=seed
uniform vec4  uBurst;
uniform ivec2 uBurstSlot;   // start, count（相对火花区的环形槽位）
uniform vec2  uShell;       // x = 球壳初速倍率, y = 垂柳星比例
uniform float uPhysScale;   // 物理尺度：短边/400，使花型大小随屏幕等比缩放
// 流式源（微笑时升起的光尘）
uniform vec4  uStream;      // xy = 发射点, z = 横向展开宽度
uniform ivec2 uStreamSlot;

layout(location = 0) out vec4 oState0;
layout(location = 1) out vec4 oState1;

${HASH}
${ELLIPSE}

// 物理常量。数值在 390×844 手机竖屏上标定（此时 uPhysScale≈1）。
// 速度与加速度都乘 uPhysScale，使花型在不同屏幕尺寸下保持几何相似：
// 花型半径始终约占屏幕短边的 60%，不会在桌面上缩成一个点、在手机上溢出画面。
const float GRAVITY  = 760.0;
const float DRAG     = 0.72;
const float BOUNCE   = 0.52;

bool inRing(int rel, int start, int count, int cap) {
  if (count <= 0) return false;
  int d = rel - start;
  if (d < 0) d += cap;
  return d < count;
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  int W = int(uTexSize.x);
  int idx = ij.y * W + ij.x;
  int total = W * int(uTexSize.y);
  int sparkCap = total - uRainSlots;

  vec4 s0 = texelFetch(uState0, ij, 0);
  vec4 s1 = texelFetch(uState1, ij, 0);

  vec2 pos = s0.xy;
  vec2 vel = s0.zw;
  float life = s1.x;
  float maxLife = s1.y;
  float hue = s1.z;
  float seed = s1.w;

  /* ---------------- 雨区 ---------------- */
  // maxLife 兼作状态标记：1.0 = 下落中，0.3 = 撞到脸后附着的水痕
  if (idx < uRainSlots) {
    bool wanted = float(idx) < float(uRainSlots) * uRainIntensity;
    bool splash = maxLife < 0.5;

    if (life <= 0.0) {
      if (wanted) {
        vec2 r = hash21(float(idx) * 1.371 + uTime * 0.917);
        float r3 = hash11(float(idx) * 7.13 + uTime * 2.31);
        pos = vec2(r.x * uScreen.x, -r.y * uScreen.y * 0.45 - 20.0);
        vel = vec2(-70.0 + 130.0 * r3, 720.0 + 700.0 * r.y);
        life = 1.0;
        maxLife = 1.0;
        hue = 0.0;
        seed = r3;
      }
    } else if (splash) {
      // 水痕：贴着脸缓慢下滑并迅速淡出，避免头部区域出现「圆形空洞」
      life -= uDt;
      vel *= 0.80;
      vel.y += 240.0 * uDt;
      pos += vel * uDt;
    } else {
      vec2 next = pos + vel * uDt;
      if (uHeadValid > 0.5 && headDist(next, uHead) < 1.0) {
        float rs = hash11(float(idx) * 3.77 + uTime * 5.1);
        maxLife = 0.3;
        life = 0.3;
        vel = vec2((rs - 0.5) * 90.0, 50.0);
        pos = next;
      } else if (next.y > uScreen.y + 30.0) {
        life = 0.0;
      } else {
        pos = next;
        vel.y += 120.0 * uDt;   // 轻微加速，避免雨速看起来匀速呆板
      }
      if (!wanted) life = 0.0;  // 雨量下调时自然收束
    }

    oState0 = vec4(pos, vel);
    oState1 = vec4(life, maxLife, hue, seed);
    return;
  }

  /* ---------------- 火花区 ---------------- */
  int rel = idx - uRainSlots;

  if (life <= 0.0) {
    if (inRing(rel, uBurstSlot.x, uBurstSlot.y, sparkCap)) {
      vec2 r = hash21(float(idx) * 2.117 + uBurst.w);
      float r3 = hash11(float(idx) * 5.77 + uBurst.w * 1.7);
      // hue 必须用独立随机源：复用角度的随机数会让颜色与方向相关，出现「色扇」
      float rh = hash11(float(idx) * 11.317 + uBurst.w * 3.07);
      // 第四路随机：决定这颗是「炸开的星」还是「垂落的柳」
      float rw = hash11(float(idx) * 17.913 + uBurst.w * 2.11);

      // 球壳投影：方向在 3D 球面均匀采样后投影到 2D。
      // 这样 |v| 自带 sin(theta) 分布 —— 中心稀疏、边缘密集，
      // 正是真实烟花的观感；直接用 2D 均匀角度会得到「蒲公英毛球」。
      float cosT = r.x * 2.0 - 1.0;
      float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
      float phi = r.y * 6.28318530718;
      vec2 dir = vec2(cos(phi), sin(phi)) * sinT;

      // 垂柳星：方向偏向下、初速慢、寿命长、重力大，形成「垂落的金丝」。
      // 真实烟花的花型辨识度几乎全来自这类异质星，全部同速只会得到一个圆球。
      bool willow = rw < uShell.y;
      // 只把方向往上压，不再缩放 dir 的长度：长度缩放会与下面的 sp 缩放叠加，
      // 导致柳星速度被两次打折、几乎原地不动。
      if (willow) dir = normalize(dir + vec2(0.0, 0.85));

      // 半径缩放：初速决定烟火半径，全部数值均以 390×844 手机竖屏标定，
      // 再由 uPhysScale 等比放大到其它屏幕。
      // 球壳投影的视觉特征是**边缘最密最亮**，半径必须落在屏内才读得出「一朵花」。
      // 旧参数 900~1240px/s 对应半径约 600~700px，边缘全在屏幕外，
      // 用户只看到中心稀疏的几粒 —— 这是「不像烟花」的首要原因。
      // 现在 380~510px/s 实测半径 148~253px（屏宽的 38%~65%），花型完整落在画面内。
      float sp = (380.0 + r3 * 130.0) * uBurst.z * uShell.x * uPhysScale;
      if (willow) sp *= 0.45;                     // 柳星飞得近，靠重力拉长
      // 出生壳层与半径成比例：小半径爆发不该从整片空域出生
      pos = uBurst.xy + dir * (6.0 + r3 * 22.0) * uShell.x;
      vel = dir * sp;

      // 星体的「上抛-回落」由统一重力负责，不再额外给竖直偏置：
      // 旧实现的 -150*power 会把整个球壳向上平移，看起来像被风吹偏而不是爆炸。
      if (!willow) vel += vec2(0.0, -60.0 * uBurst.z * uPhysScale);

      // 寿命区间做成**互不相交的三段**，让下游仅凭 maxLife 就能反推星体类型：
      //   普通星 [0.50, 0.95] / 垂柳星 [1.15, 1.65] / 光尘 [1.85, 2.30]
      // 这样无需占用额外纹理通道，就能在物理与着色阶段给三类粒子不同的重力、阻力与拖尾。
      maxLife = willow ? (1.15 + r3 * 0.50) : (0.50 + r3 * 0.45);
      life = maxLife;
      hue = 0.10 + pow(rh, 0.85) * 0.90;   // 以金/琥珀为主，两端各留少量白金与品红
      // 用 seed 的符号位携带「是否垂柳星」：四通道已被 life/maxLife/hue/seed 占满，
      // 但 seed 只被下游用于尺寸与闪烁相位（都可取绝对值），符号位是免费的第五个布尔量。
      seed = willow ? -r3 : r3;
    } else if (inRing(rel, uStreamSlot.x, uStreamSlot.y, sparkCap)) {
      vec2 r = hash21(float(idx) * 3.319 + uStream.w);
      float r3 = hash11(float(idx) * 9.41 + uStream.w * 2.3);
      // 慢慢上浮的光尘，而不是从嘴角「喷射」：
      // 旧实现给了 60~230 px/s 的定向速度，看起来像漏气或喷水，是「嘴部怪特效」的主因。
      float ang = -1.5707963 + (r.x - 0.5) * 1.1;
      float sp = (14.0 + r.y * 46.0) * uPhysScale;
      float w = max(uStream.z, 20.0);
      pos = uStream.xy + vec2((r.x - 0.5) * w, (r.y - 0.5) * (w * 0.35));
      vel = vec2(cos(ang), sin(ang)) * sp;
      // 光尘需要**向上的净位移**，但统一重力 760px/s² 会在 0.1s 内吃掉任何初速
      // （实测按统一重力 + 40px/s 初速，1.4s 只上升 1px，实际在往下掉）。
      // 因此光尘用自己的负重力（持续浮力）+ 高阻力：缓慢匀速、无坠落感。
      // 扫描标定：grav=-140、drag=1.20 时 2.08s 内上升约 185px，正是「浮起的金尘」。
      maxLife = 1.85 + r3 * 0.45;
      life = maxLife;
      hue = 0.06 + r3 * 0.34;    // 偏白金，做「光尘」而不是「烟花」
      seed = r3;
    }
    oState0 = vec4(pos, vel);
    oState1 = vec4(life, maxLife, hue, seed);
    return;
  }

  life -= uDt;
  if (life <= 0.0) {
    oState0 = vec4(pos, vel);
    oState1 = vec4(0.0, maxLife, hue, seed);
    return;
  }

  // seed 的符号位在出生时被用作「垂柳星」标记（见上方 bloom 分支），
  // 负值代表慢速下坠星；光尘由寿命区间（>1.8s）单独识别。
  bool willowStar = seed < 0.0;
  bool dust = maxLife > 1.8;

  // 三类粒子给不同的重力与阻力：
  //   普通星 —— 干脆利落地抛射
  //   垂柳星 —— 被重力拉出长尾（数值经离线扫描标定，见出生分支注释）
  //   光尘   —— 负重力 + 高阻力，持续缓慢上浮，不回落
  // 重力是「像素/秒²」，随屏幕尺度线性缩放；阻力是无量纲的时间常数，不缩放。
  float grav = (dust ? -140.0 : (willowStar ? 420.0 : GRAVITY)) * uPhysScale;
  float drag = dust ? 1.20 : (willowStar ? 1.20 : DRAG);
  float damp = 1.0 / (1.0 + drag * uDt);

  vel.y += grav * uDt;
  vel *= damp;
  vec2 next = pos + vel * uDt;

  // 与头部弹性碰撞。
  //
  // 判据是**边界穿越**（上一帧在椭圆外、这一帧在椭圆内），而不是「当前在椭圆内」，
  // 也不是「速度朝内」。原因：发射源位于头部碰撞体内部且偏离中心，
  //   · 用「在内部就反弹」：烟花出生即被弹到边缘，堆成一圈光球；
  //   · 用「速度朝内就反弹」：嘴在中心下方，向上喷出的粒子在下半部的法线朝下，
  //     会被误判成朝内而全部弹回，于是堆成一个「碗」。
  // 穿越检测让内部出生的粒子自由掠过脸部飞出，只有从外部落回时才真正撞击反弹。
  if (uHeadValid > 0.5) {
    vec2 inv = 1.0 / max(uHead.zw, vec2(1.0));
    vec2 qPrev = (pos - uHead.xy) * inv;
    vec2 qNext = (next - uHead.xy) * inv;
    if (dot(qNext, qNext) < 1.0 && dot(qPrev, qPrev) >= 1.0) {
      vec2 d = next - uHead.xy;
      vec2 n = normalize(qNext * inv);
      vel = reflect(vel, n) * BOUNCE;
      float k = 1.0 / max(length(qNext), 1e-3);
      next = uHead.xy + d * k * 1.01;
      life = min(life, 0.42);   // 撞击后迅速熄灭，形成「溅开」而非「绕圈」
      hue = min(hue + 0.18, 1.0);
    }
  }

  // 出屏即回收，不浪费后续帧的算力
  if (next.x < -60.0 || next.x > uScreen.x + 60.0 || next.y > uScreen.y + 60.0) {
    life = 0.0;
  }

  oState0 = vec4(next, vel);
  oState1 = vec4(life, maxLife, hue, seed);
}`;

/* ============================ 2. 火花绘制 ============================ */

export const SPARK_VS = `#version 300 es
precision highp float;

layout(location = 0) in float aIndex;

uniform sampler2D uState0;
uniform sampler2D uState1;
uniform vec2  uTexSize;
uniform vec2  uScreen;
uniform int   uRainSlots;
uniform float uPointScale;
uniform float uTime;
uniform vec4  uHead;
uniform float uHeadValid;

out vec3  vColor;
out float vAlpha;

${PALETTE}
${ELLIPSE}

void main() {
  int idx = int(aIndex) + uRainSlots;
  int W = int(uTexSize.x);
  ivec2 ij = ivec2(idx % W, idx / W);

  vec4 s0 = texelFetch(uState0, ij, 0);
  vec4 s1 = texelFetch(uState1, ij, 0);

  float life = s1.x;
  if (life <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // 裁剪掉，等价于不绘制
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }

  float t = clamp(life / max(s1.y, 1e-3), 0.0, 1.0);
  vec2 ndc = (s0.xy / uScreen) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);

  // seed 的符号位是「垂柳星」标记，取绝对值后再当随机数用
  float seed = abs(s1.w);
  bool willowStar = s1.w < 0.0;
  bool dust = s1.y > 1.8;

  // 垂柳星刻意画细：它是垂落的金丝，粗点会糊成一片而不是丝；
  // 光尘最小最淡，是一层氛围而不是主体。
  float base = dust ? 1.1 : ((willowStar ? 1.4 : 2.1) + seed * (willowStar ? 1.8 : 3.2));
  gl_PointSize = base * (0.32 + 0.68 * t) * uPointScale;

  vec3 col = giftPalette(s1.z);
  // 白热只存在于爆发最初的一瞬，否则整片烟花会褪成白色、丢掉礼物色
  col = mix(col, vec3(1.0, 0.96, 0.9), pow(t, 4.5) * 0.6);

  // 贴近头部边缘时增亮：让「撞在脸上」这件事被看见
  if (uHeadValid > 0.5) {
    float hd = headDist(s0.xy, uHead);
    float nearRim = smoothstep(1.55, 1.0, hd);
    col *= 1.0 + nearRim * 1.5;
  }

  vColor = col;

  // 闪烁：烟花的标志性特征。只在生命后段出现，早期保持稳定的亮芯；
  // 光尘不闪（它是氛围，闪烁会显得噪）。
  float tw = 0.55 + 0.45 * sin(uTime * (16.0 + seed * 30.0) + seed * 47.0);
  float twMix = dust ? 0.75 : mix(1.0, tw, smoothstep(0.75, 0.2, t));
  vAlpha = pow(t, 0.62) * (dust ? 0.34 : 0.80) * twMix;
}`;

export const SPARK_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 oColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  // 双层衰减：锐利芯 + 柔和外晕，单层 gaussian 会显得糊
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 2.2) * 0.42;
  oColor = vec4(vColor * (core + halo) * vAlpha, 1.0);
}`;

/* ============================ 2b. 火花拖尾 ============================ */
/**
 * 只有圆点的粒子看起来是「星尘」，有拖尾才是「烟花」。
 * 拖尾长度与瞬时速度成正比，于是爆炸初期是放射状光丝、末期收成点状余烬，
 * 这一条对「礼物感」的贡献比任何调色都大。
 */
export const SPARK_TRAIL_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aVert;   // x = 火花序号, y = 端点 (0 头 / 1 尾)

uniform sampler2D uState0;
uniform sampler2D uState1;
uniform vec2  uTexSize;
uniform vec2  uScreen;
uniform int   uRainSlots;

out vec3  vColor;
out float vAlpha;

${PALETTE}

void main() {
  int idx = int(aVert.x) + uRainSlots;
  int W = int(uTexSize.x);
  ivec2 ij = ivec2(idx % W, idx / W);

  vec4 s0 = texelFetch(uState0, ij, 0);
  vec4 s1 = texelFetch(uState1, ij, 0);

  float life = s1.x;
  if (life <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }

  float t = clamp(life / max(s1.y, 1e-3), 0.0, 1.0);
  float speed = length(s0.zw);
  vec2 dir = s0.zw / max(speed, 1e-3);
  // 垂柳星的拖尾必须明显更长：它靠「垂落的金丝」建立花型辨识度，
  // 与普通星同长度就只剩一堆点。用寿命区间判定类型（见 SIMULATE_FS 的寿命分段）。
  bool willowStar = s1.y > 1.0 && s1.y < 1.8;
  bool dust = s1.y > 1.8;
  float maxLen = willowStar ? 54.0 : (dust ? 6.0 : 26.0);
  float ratio = willowStar ? 0.032 : (dust ? 0.004 : 0.015);
  float len = min(speed * ratio, maxLen) * (0.22 + 0.78 * t);

  vec2 p = s0.xy - dir * len * aVert.y;
  vec2 ndc = (p / uScreen) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);

  vec3 col = giftPalette(s1.z);
  col = mix(col, vec3(1.0, 0.95, 0.88), pow(t, 4.0) * 0.5);
  vColor = col;
  // 头亮尾灭。柳星那条长尾要更淡，否则会糊成一整片而不是丝
  float tailGain = willowStar ? 0.38 : (dust ? 0.30 : 0.55);
  vAlpha = (1.0 - aVert.y) * pow(t, 0.7) * tailGain;
}`;

export const SPARK_TRAIL_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 oColor;
void main() {
  oColor = vec4(vColor * vAlpha, 1.0);
}`;

/* ============================ 3. 雨绘制 ============================ */

export const RAIN_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aVert;   // x = 粒子序号, y = 线段端点 (0 头 / 1 尾)

uniform sampler2D uState0;
uniform sampler2D uState1;
uniform vec2 uTexSize;
uniform vec2 uScreen;
uniform vec4 uHead;
uniform float uHeadValid;

out vec3  vColor;
out float vAlpha;

${PALETTE}
${ELLIPSE}

void main() {
  int idx = int(aVert.x);
  int W = int(uTexSize.x);
  ivec2 ij = ivec2(idx % W, idx / W);

  vec4 s0 = texelFetch(uState0, ij, 0);
  vec4 s1 = texelFetch(uState1, ij, 0);

  if (s1.x <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vAlpha = 0.0;
    return;
  }

  // maxLife < 0.5 表示这滴已撞到脸、转为附着的水痕
  bool splash = s1.y < 0.5;
  float t = clamp(s1.x / max(s1.y, 1e-3), 0.0, 1.0);
  float speed = length(s0.zw);
  vec2 dir = normalize(s0.zw + vec2(0.0, 1e-3));
  // 拖尾长度与速度成正比：越快的雨拉得越长，天然产生景深分层
  float len = splash ? (1.4 + 2.6 * t) : (7.0 + speed * 0.014 + s1.w * 10.0);
  vec2 p = s0.xy - dir * len * aVert.y;

  vec2 ndc = (p / uScreen) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);

  float depth = 0.22 + s1.w * 0.78;   // 用 seed 当景深：近处更亮，远处隐入背景
  vec3 col = rainColor(s1.w);
  if (uHeadValid > 0.5) {
    col *= 1.0 + smoothstep(1.4, 1.02, headDist(s0.xy, uHead)) * 0.5;
  }
  if (splash) col = mix(col, vec3(0.92, 0.97, 1.0), 0.65);  // 水痕更白亮
  vColor = col * depth;
  // 下落中：头亮尾淡形成运动模糊；水痕：整体随寿命淡出
  vAlpha = splash ? (t * 0.95) : ((1.0 - aVert.y * 0.88) * depth * depth);
}`;

export const RAIN_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
out vec4 oColor;
void main() {
  oColor = vec4(vColor * vAlpha * 0.42, 1.0);
}`;

/* ============================ 4. 辉光 ============================ */

export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
out vec4 oColor;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // soft knee：硬阈值会让辉光边界出现台阶
  float k = clamp((l - uThreshold) / max(uThreshold, 1e-3), 0.0, 1.0);
  oColor = vec4(c * k * k, 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;          // 已含 1/分辨率
out vec4 oColor;
void main() {
  // 9-tap 线性采样等效 17-tap 高斯，硬件插值白送一半采样
  vec3 s = texture(uTex, vUv).rgb * 0.2270270270;
  s += texture(uTex, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  s += texture(uTex, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  s += texture(uTex, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  s += texture(uTex, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  oColor = vec4(s, 1.0);
}`;

/* ============================ 5. 合成 ============================ */

export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uVideo;
uniform sampler2D uScene;
uniform sampler2D uBloom0;   // 1/4
uniform sampler2D uBloom1;   // 1/16

uniform vec2  uScreen;
uniform vec2  uVideoScale;   // cover 缩放
uniform vec2  uVideoOffset;
uniform float uBloomStrength;

uniform vec4  uHead;
uniform float uHeadValid;
uniform float uRim;          // 头部辉光环强度
uniform float uMoodCool;     // 微笑氛围
uniform float uMoodWarm;     // 大笑氛围
uniform float uFlash;        // 爆发瞬间闪光
uniform vec3  uShock;        // xy = 中心, z = 半径
uniform float uShockLife;
uniform vec2  uShake;        // 镜头震动偏移（归一化 uv 空间）
uniform float uBeauty;       // 美颜强度 0..1
uniform vec2  uTexel;        // 视频层 1 像素对应的 uv 步长

out vec4 oColor;

${PALETTE}
${ELLIPSE}

/**
 * 轻量磨皮（direct-light 直播标配的第一层）。
 *
 * 用「十字 5-tap 均值」当低频估计，再按与中心的亮度差做保边混合：
 * 差异小 = 皮肤区域 → 取模糊值（磨掉噪点与毛孔）；
 * 差异大 = 眼睛/眉毛/嘴唇/发丝边缘 → 保留原值（不糊五官）。
 * 只花 5 次纹理采样，远低于双边滤波，手机端可承受。
 */
vec3 smoothSkin(vec2 uv, vec3 center, float amount) {
  if (amount <= 0.001) return center;
  vec2 s = uTexel * 2.0;
  vec3 sum = center;
  sum += texture(uVideo, clamp(uv + vec2(s.x, 0.0), 0.0, 1.0)).rgb;
  sum += texture(uVideo, clamp(uv - vec2(s.x, 0.0), 0.0, 1.0)).rgb;
  sum += texture(uVideo, clamp(uv + vec2(0.0, s.y), 0.0, 1.0)).rgb;
  sum += texture(uVideo, clamp(uv - vec2(0.0, s.y), 0.0, 1.0)).rgb;
  vec3 blurred = sum * 0.2;

  float lc = dot(center,  vec3(0.2126, 0.7152, 0.0722));
  float lb = dot(blurred, vec3(0.2126, 0.7152, 0.0722));
  // 边缘保护：亮度差超过 ~0.09 就快速回到原图，五官不被糊掉
  float edge = smoothstep(0.035, 0.115, abs(lc - lb));
  vec3 skin = mix(blurred, center, edge);
  return mix(center, skin, amount);   // amount=0 时严格等于原图
}

void main() {
  vec2 px = vUv * uScreen;

  /* -- 摄像头层：镜像 + cover，原样直通 -- */
  // 人脸不做任何默认调色。此前的压暗/去饱和/提亮/增饱和/柔光叠加五连，
  // 实测把中间调整体抬高 0.21 并压低对比度，人脸呈「灰蒙发糊」的塑料感。
  // 摄像头出什么就是什么，特效负责加光，不负责改人。
  vec2 vuv = (vUv - uVideoOffset + uShake) / uVideoScale;
  vuv.x = 1.0 - vuv.x;
  vuv = clamp(vuv, 0.0, 1.0);
  vec3 cam = texture(uVideo, vuv).rgb;

  // 可选美颜 + 补光，默认关闭（uBeauty = 0 时逐位等于原图）
  cam = smoothSkin(vuv, cam, uBeauty);
  cam = mix(cam, pow(max(cam, 0.0), vec3(0.94)) * 1.03, uBeauty);

  /* -- 氛围光与特效光：全部累积到独立层，不污染摄像头像素 -- */
  // 分开累积的意义：摄像头层保持原样，只有这一层参与辉光与暗角，
  // 于是「人脸不动、特效发光」两件事互不干扰。
  vec3 camGlow = vec3(0.0);

  float topGrad = smoothstep(0.85, 0.0, vUv.y);
  camGlow += vec3(0.16, 0.30, 0.52) * topGrad * uMoodCool * 0.42;
  camGlow += vec3(0.42, 0.20, 0.06) * uMoodWarm * 0.26;

  /* -- 头部辉光环：碰撞可见性的主要载体，必须细而亮，宽了会糊成甜甜圈 -- */
  if (uHeadValid > 0.5) {
    float d = headDist(px, uHead);
    float ring = smoothstep(1.14, 1.005, d) * smoothstep(0.955, 1.005, d);
    vec3 ringCol = mix(vec3(0.45, 0.72, 1.0), vec3(1.0, 0.72, 0.35), uMoodWarm);
    camGlow += ringCol * ring * uRim * 0.75;
    // 内侧极淡补光，让人脸从背景里「浮」起来，强度必须很低否则整张脸发白
    camGlow += ringCol * smoothstep(1.0, 0.6, d) * uRim * 0.035;
  }

  /* -- 冲击波环：从嘴部扩散，把「大笑」和「爆发」在视觉上绑定 -- */
  if (uShockLife > 0.0) {
    float d = length(px - uShock.xy);
    float w = 12.0 + uShock.z * 0.05;   // 细环，宽环会糊成一团光斑
    float ring = exp(-pow((d - uShock.z) / w, 2.0) * 2.4);
    camGlow += vec3(1.0, 0.80, 0.45) * ring * uShockLife * 0.62;
  }

  /* -- 粒子的独立发光层 -- */
  vec3 scene = texture(uScene, vUv).rgb;

  /* -- 背景分离：只压暗/去饱和脸部椭圆之外，人脸像素一个不动 --
   *
   * 这是各类 AR 滤镜的通用做法（如 sachadee 的 face-oval clip）：
   * 不靠"修人"来突出人，而是把背景退后。此前我们把整幅画面一起调色，
   * 人脸的灰蒙来自这里；改成只处理背景后，人保持原样但有立体层次。
   */
  float faceMask = 0.0;
  if (uHeadValid > 0.5) {
    faceMask = 1.0 - smoothstep(0.92, 1.30, headDist(px, uHead));
    float gl2 = dot(cam, vec3(0.2126, 0.7152, 0.0722));
    vec3 muted = mix(cam, vec3(gl2), 0.20) * 0.82;
    cam = mix(muted, cam, faceMask);   // faceMask=1 处严格等于原图
  }
  vec3 bloom = texture(uBloom0, vUv).rgb * 0.62 + texture(uBloom1, vUv).rgb * 0.95;

  // 发光层单独滚降。此前 filmic 作用在整幅画面上，把中间整体抬 0.13~0.3
  // （filmic(0.1)=0.126, filmic(0.2)=0.30），暗部被提起 = 灰蒙发糊的主因；
  // 同时它把烟花峰值压到 0.81，粒子永远到不了白热，看着「不亮」。
  // 现在：camera 原样，只有光效做高光滚降，且滚降只发生在 1.0 以上。
  vec3 emissive = scene + bloom * uBloomStrength;
  emissive += vec3(1.0, 0.86, 0.60) * uFlash * 0.30;
  emissive = emissive / (1.0 + max(vec3(0.0), emissive - 1.0) * 0.25);

  // 暗角：真实镜头本来就有，幅度控制在边缘 -15%（0.30*0.5），属自然范围。
  // 关键是它只乘摄像头层，不参与发光层 —— 旧实现给整幅画面做暗角后又被
  // ACES 抬亮，等于「先压暗再提亮」，暗部细节被碾平，这才有发灰感。
  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * 0.30;

  vec3 col = cam * vig + camGlow + emissive;

  // 弱噪点：抵消暗部 8bit 色带，顺带去掉「CG 塑料感」
  float n = fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) * 0.014;

  oColor = vec4(min(col, vec3(1.0)), 1.0);
}`;
