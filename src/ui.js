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
      topbar: $('topbar'),
      viewers: $('viewers'),
      hypeCount: $('hypeCount'),
      gift: $('gift'),
      giftCombo: $('giftCombo'),
      hearts: $('hearts'),
    };
    this._lastState = -1;
    this._toastTimer = 0;
    this._giftTimer = 0;
    this._lastCombo = -1;
    this._hypeAcc = 0;
    this._viewers = 12000;
    this._heartPool = [];
    this._heartCursor = 0;
    this._buildHearts();
  }

  /* ---------- 飘心（直播间点赞的视觉签名） ----------
   * 预建 12 个节点循环复用：运行期不再 createElement，
   * 动画走 CSS transform + opacity，全程在合成线程，不占主线程帧预算。
   */
  _buildHearts() {
    const box = this.el.hearts;
    if (!box) return;
    const faces = ['❤️', '🧡', '💛', '✨', '🎉'];
    for (let i = 0; i < 12; i++) {
      const s = document.createElement('i');
      s.className = 'heart';
      s.textContent = faces[i % faces.length];
      box.appendChild(s);
      this._heartPool.push(s);
    }
  }

  /** 放一个飘心。同一节点重启动画需先移除 class 并强制 reflow 读一次 */
  popHeart() {
    if (!this._heartPool.length) return;
    const el = this._heartPool[this._heartCursor];
    this._heartCursor = (this._heartCursor + 1) % this._heartPool.length;
    el.classList.remove('fly');
    void el.offsetWidth;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`);
    el.style.setProperty('--dur', `${1.5 + Math.random() * 0.9}s`);
    el.classList.add('fly');
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
    if (this.el.topbar) this.el.topbar.classList.remove('hidden');
    // 性能面板默认收起：直播间里工程仪表盘是噪音，需要时用按钮唤出
    this.el.perf.classList.add('hidden');
    if (this.el.btnPerf) this.el.btnPerf.setAttribute('aria-pressed', 'false');
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

  /* ---------- 礼物横幅 / 连击 ---------- */

  /** 触发礼物横幅并更新连击数（数字做弹跳，连击感的关键） */
  showGift(combo) {
    const g = this.el.gift;
    if (!g) return;
    g.classList.remove('hidden');
    g.classList.remove('pop');
    void g.offsetWidth;
    g.classList.add('pop');
    if (combo !== this._lastCombo) {
      this._lastCombo = combo;
      this.el.giftCombo.textContent = `x${combo}`;
    }
    // 连击越高，横幅热度等级越高（配色随之升级）
    g.dataset.tier = combo >= 6 ? 'hot' : combo >= 3 ? 'warm' : 'base';
    this.popHeart();
    this.popHeart();
    clearTimeout(this._giftTimer);
    this._giftTimer = setTimeout(() => this.hideGift(), 3200);
  }

  hideGift() {
    if (!this.el.gift) return;
    this.el.gift.classList.add('hidden');
    this._lastCombo = -1;
  }

  /**
   * 直播间热度：微笑时持续冒飘心 + 在线人数随表情强度缓慢上涨。
   * 这是「有人在看、有人在互动」的错觉来源，纯 UI 成本极低。
   */
  setHype(smile, laugh, combo) {
    const heat = Math.max(smile, laugh);
    this._hypeAcc += heat;
    if (this._hypeAcc > 1.1) {
      this._hypeAcc = 0;
      this.popHeart();
    }
    if (heat > 0.25) {
      this._viewers += Math.round(heat * 9);
      if (this.el.viewers) {
        this.el.viewers.textContent = this._viewers >= 10000
          ? `${(this._viewers / 10000).toFixed(1)}万`
          : String(this._viewers);
      }
    }
    if (this.el.hypeCount) {
      this.el.hypeCount.textContent = String(combo);
    }
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
    if (this.el.btnPerf) {
      this.el.btnPerf.addEventListener('click', (e) => {
        const hidden = this.el.perf.classList.toggle('hidden');
        e.currentTarget.setAttribute('aria-pressed', String(!hidden));
      });
    }
  }
}
