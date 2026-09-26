/**
 * 表情状态机。
 *
 * 「笑了不出效果 / 没笑却触发」的根因不是阈值调得不好，而是**每个人的静息表情值不同**：
 * 有人自然状态 mouthSmile 就有 0.22，有人全力笑也只到 0.45。固定阈值必然两头不讨好。
 *
 * 解法是个人化基线校准：
 *   1. 启动时用 1.2s 采集该用户的中性基线；
 *   2. 之后所有判定都在「相对基线的剩余空间」里归一化：n = (raw - base) / (1 - base)；
 *   3. 在 NEUTRAL 状态下持续缓慢追踪基线，应对光线变化与姿态漂移。
 *
 * 在归一化之上再叠三重抗抖动：EMA 平滑、迟滞阈值、连续帧确认。
 */

export const State = { NEUTRAL: 0, SMILE: 1, LAUGH: 2 };

const DEFAULTS = {
  // 阈值作用于「归一化后」的值，因此可以调得比固定阈值方案更灵敏
  smileEnter: 0.20,
  smileExit: 0.11,
  laughEnter: 0.30,
  laughExit: 0.17,
  enterFrames: 2,
  exitFrames: 9,
  smoothing: 0.30,
  // 0.9s：直播特效讲「摩擦力归零」，1.2s 空等已经能让人划走
  calibrateSeconds: 0.9,
  burstCooldown: 0.38,
  // 连击节奏：0.62s → 0.52s，让持续大笑的连击涨得更有推背感
  sustainInterval: 0.52,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 中性基线追踪器：快速下修、缓慢上修，始终贴着「这个人不笑时的值」 */
class Baseline {
  constructor() { this.v = 0; this._sum = 0; this._n = 0; }
  sample(raw) { this._sum += raw; this._n++; this.v = this._sum / this._n; }
  trackIdle(raw, dt) {
    if (raw < this.v) {
      this.v += (raw - this.v) * (1 - Math.pow(0.5, dt / 0.6));   // 0.6s 半衰期，快速贴低点
    } else {
      this.v += (raw - this.v) * (1 - Math.pow(0.5, dt / 6.0)) * 0.4; // 上修很慢，避免把笑吃成基线
    }
    this.v = clamp01(this.v);
  }
  norm(raw) {
    return clamp01((raw - this.v) / Math.max(1 - this.v, 0.25));
  }
}

export class ExpressionFSM {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.state = State.NEUTRAL;
    this.smile = 0;
    this.laugh = 0;
    this.calibrating = true;
    this.calibrateProgress = 0;
    this._calT = 0;
    this._baseSmile = new Baseline();
    this._baseJaw = new Baseline();
    this._enterCount = 0;
    this._exitCount = 0;
    this._sinceBurst = 9;
    this._sustain = 0;
  }

  reset() {
    this.calibrating = true;
    this.calibrateProgress = 0;
    this._calT = 0;
    this._baseSmile = new Baseline();
    this._baseJaw = new Baseline();
    this.state = State.NEUTRAL;
    this.smile = 0;
    this.laugh = 0;
  }

  /**
   * @param {{found:boolean, smile:number, jaw:number, squint:number, pucker:number}} s 原始信号
   * @param {number} dt 秒
   */
  update(s, dt) {
    const c = this.cfg;

    if (!s || !s.found) {
      // 丢脸时平滑回落，而不是瞬间断掉特效
      const k = 1 - Math.pow(0.5, dt / 0.35);
      this.smile += (0 - this.smile) * k;
      this.laugh += (0 - this.laugh) * k;
      if (this.state !== State.NEUTRAL && this.smile < c.smileExit && this.laugh < c.laughExit) {
        this.state = State.NEUTRAL;
      }
      return { state: this.state, smile: this.smile, laugh: this.laugh, burst: false, changed: false };
    }

    /* ---- 校准阶段：只采样，不触发特效 ---- */
    if (this.calibrating) {
      this._calT += dt;
      this._baseSmile.sample(s.smile);
      this._baseJaw.sample(s.jaw);
      this.calibrateProgress = clamp01(this._calT / c.calibrateSeconds);
      if (this._calT >= c.calibrateSeconds) this.calibrating = false;
      return { state: State.NEUTRAL, smile: 0, laugh: 0, burst: false, changed: false, calibrating: true };
    }

    /* ---- 归一化 ---- */
    // Duchenne 加权：嘴角上扬为主，眼周收缩为辅（真笑必然带眼周动作，
    // 且大笑张嘴时 mouthSmile 会被拉低，squint 正好补上这块证据）；
    // 撅嘴/漏斗嘴则扣分，排除说话与嘟嘴。
    const smileN = clamp01(
      this._baseSmile.norm(s.smile) * 0.78 +
      clamp01(s.squint) * 0.35 -
      clamp01(s.pucker) * 0.35
    );
    const jawN = this._baseJaw.norm(s.jaw);

    // 大笑判定：微笑是**必要条件**而非加权项。
    // 若只把 smile 当权重（如 jaw * (0.45 + 0.55 * smile)），纯张嘴仍能拿到
    // 0.45 倍分数从而误触发 —— 打哈欠、说话、唱歌都会放烟花。
    // 这里改成门控：没有笑意证据时，张嘴对大笑的贡献严格为 0。
    const gateRaw = clamp01((smileN - 0.08) / 0.24);
    const gate = gateRaw * gateRaw * (3 - 2 * gateRaw);  // smoothstep，避免门限处跳变
    const laughN = clamp01(jawN * gate);

    const k = 1 - Math.pow(1 - c.smoothing, Math.max(dt, 1e-3) * 60); // 帧率无关的 EMA
    this.smile += (smileN - this.smile) * k;
    this.laugh += (laughN - this.laugh) * k;

    /* ---- 迟滞 + 连续帧确认 ---- */
    const prev = this.state;
    let next = this.state;

    if (this.state === State.LAUGH) {
      if (this.laugh < c.laughExit) {
        if (++this._exitCount >= c.exitFrames) next = this.smile > c.smileExit ? State.SMILE : State.NEUTRAL;
      } else this._exitCount = 0;
    } else if (this.state === State.SMILE) {
      if (this.laugh >= c.laughEnter) {
        if (++this._enterCount >= c.enterFrames) next = State.LAUGH;
      } else {
        this._enterCount = 0;
        if (this.smile < c.smileExit) {
          if (++this._exitCount >= c.exitFrames) next = State.NEUTRAL;
        } else this._exitCount = 0;
      }
    } else {
      // 中性状态下顺带追踪基线漂移（光线/姿态变化）
      this._baseSmile.trackIdle(s.smile, dt);
      this._baseJaw.trackIdle(s.jaw, dt);
      if (this.smile >= c.smileEnter) {
        if (++this._enterCount >= c.enterFrames) next = State.SMILE;
      } else this._enterCount = 0;
    }

    if (next !== this.state) {
      this.state = next;
      this._enterCount = 0;
      this._exitCount = 0;
      if (next === State.LAUGH) this._sustain = c.sustainInterval; // 进入即可立刻爆发
    }

    /* ---- 烟花触发节奏 ---- */
    this._sinceBurst += dt;
    let burst = false;
    if (this.state === State.LAUGH) {
      this._sustain += dt;
      if (this._sustain >= this.cfg.sustainInterval && this._sinceBurst > c.burstCooldown) {
        burst = true;
        this._sustain = 0;
        this._sinceBurst = 0;
      }
    } else {
      this._sustain = 0;
    }

    return { state: this.state, smile: this.smile, laugh: this.laugh, burst, changed: next !== prev };
  }

  /** 雨强度：smoothstep 让「刚开始笑」到「大笑」的雨量过渡不生硬 */
  get rainIntensity() {
    const c = this.cfg;
    const t = Math.max(0, Math.min(1, (this.smile - c.smileExit) / (0.62 - c.smileExit)));
    return t * t * (3 - 2 * t);
  }

  get debug() {
    return {
      baseSmile: this._baseSmile.v,
      baseJaw: this._baseJaw.v,
    };
  }
}
