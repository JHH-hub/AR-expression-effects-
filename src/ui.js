/**
 * UI 层：把状态映射到 DOM。
 *
 * 所有 DOM 写入集中在此处并由 main.js 节流调用（~8Hz）。
 * 逐帧写 DOM 会触发样式重算，在粒子满负载时足以吃掉 3–5ms 主线程时间。
 */

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.el = {
      gate: $('gate'),
      gateMsg: $('gateMsg'),
      btnStart: $('btnStart'),
      hud: $('hud'),
      stateTag: $('stateTag'),
      stateIcon: $('stateIcon'),
      barSmile: $('barSmile'),
      barLaugh: $('barLaugh'),
      valSmile: $('valSmile'),
      valLaugh: $('valLaugh'),
      perf: $('perf'),
      pFps: $('pFps'),
      pCount: $('pCount'),
      pQuality: $('pQuality'),
      pInfer: $('pInfer'),
      pBackend: $('pBackend'),
      calib: $('calib'),
      calibRing: $('calibRing'),
      calibPct: $('calibPct'),
      calibHint: $('calibHint'),
      controls: $('controls'),
      btnPerf: $('btnPerf'),
      btnBurst: $('btnBurst'),
      btnRecal: $('btnRecal'),
      toast: $('toast'),
    };
    this._lastState = -1;
    this._toastTimer = 0;
  }

  /* ---------- 启动页 ---------- */

  setGateBusy(text) {
    this.el.btnStart.disabled = true;
    this.el.btnStart.textContent = text;
  }

  setGateError(text, retryLabel = '重试') {
    this.el.gateMsg.textContent = text;
    this.el.btnStart.disabled = false;
    this.el.btnStart.textContent = retryLabel;
  }

  hideGate() {
    this.el.gate.classList.add('hidden');
    this.el.hud.classList.remove('hidden');
    this.el.controls.classList.remove('hidden');
    this.el.perf.classList.remove('hidden');
  }

  /* ---------- 校准 ---------- */

  showCalibrate(progress, hint) {
    this.el.calib.classList.remove('hidden');
    const pct = Math.round(progress * 100);
    // 圆环周长 2πr，r=34 -> 213.6
    this.el.calibRing.style.strokeDashoffset = String(213.6 * (1 - progress));
    this.el.calibPct.textContent = `${pct}%`;
    const h = hint || '请保持自然，不要笑';
    if (this._calibHint !== h) {
      this._calibHint = h;
      this.el.calibHint.textContent = h;
    }
  }

  hideCalibrate() { this.el.calib.classList.add('hidden'); }

  /* ---------- 运行时 ---------- */

  setState(state) {
    if (state === this._lastState) return;
    this._lastState = state;
    const t = this.el.stateTag;
    const i = this.el.stateIcon;
    if (state === 2) {
      t.textContent = '大笑 · 烟花绽放';
      i.textContent = '🎆';
      t.className = 'state-text laugh';
    } else if (state === 1) {
      t.textContent = '微笑 · 细雨落下';
      i.textContent = '🌧';
      t.className = 'state-text smile';
    } else {
      t.textContent = '等待表情…';
      i.textContent = '🙂';
      t.className = 'state-text neutral';
    }
  }

  setMeters(smile, laugh) {
    this.el.barSmile.style.transform = `scaleX(${Math.min(1, smile)})`;
    this.el.barLaugh.style.transform = `scaleX(${Math.min(1, laugh)})`;
    this.el.valSmile.textContent = smile.toFixed(2);
    this.el.valLaugh.textContent = laugh.toFixed(2);
  }

  setPerf(fps, active, capacity, quality, inferMs, backend) {
    this.el.pFps.textContent = fps.toFixed(0);
    this.el.pCount.textContent = `${active.toLocaleString()} / ${capacity.toLocaleString()}`;
    this.el.pQuality.textContent = quality;
    this.el.pInfer.textContent = `${inferMs.toFixed(1)} ms`;
    this.el.pBackend.textContent = backend;
  }

  toast(text, ms = 2600) {
    const el = this.el.toast;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  bind(handlers) {
    this.el.btnStart.addEventListener('click', handlers.onStart);
    this.el.btnBurst.addEventListener('click', handlers.onBurst);
    this.el.btnRecal.addEventListener('click', handlers.onRecalibrate);
    this.el.btnPerf.addEventListener('click', (e) => {
      const hidden = this.el.perf.classList.toggle('hidden');
      e.currentTarget.setAttribute('aria-pressed', String(!hidden));
    });
  }
}
