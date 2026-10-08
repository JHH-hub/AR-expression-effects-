import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const moduleFrom = async (path) => import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL(path, import.meta.url))).toString('base64')}`);
const { ExpressionFSM, State } = await moduleFrom('../src/expressionFSM.js');
const { createRenderer } = await moduleFrom('../src/rendererFactory.js');
const { PerfMonitor } = await moduleFrom('../src/perf.js');
const { ExpressionInput } = await moduleFrom('../src/expressionInput.js');
const { sweepEllipse } = await moduleFrom('../src/collision.js');
const neutral = { found: true, smile: 0, jaw: 0, squint: 0, pucker: 0 };
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function sample(fsm, signal, seconds, hz = 60) {
  let bursts = 0;
  for (let i = 0; i < Math.ceil(seconds * hz); i++) bursts += fsm.update(signal, 1 / hz).burst ? 1 : 0;
  return bursts;
}
function calibrated(hz = 60) { const fsm = new ExpressionFSM(); sample(fsm, neutral, 1.1, hz); return fsm; }
for (const hz of [30, 60]) {
  check(`no smile: open jaw + strong squint (${hz}Hz)`, () => {
    const f = calibrated(hz);
    assert.equal(sample(f, { ...neutral, jaw: 0.9, squint: 0.8 }, 2, hz), 0);
    assert.equal(f.state, State.NEUTRAL);
    assert.equal(f.rainIntensity, 0);
  });
  check(`smile creates rain, closed jaw creates no fireworks (${hz}Hz)`, () => {
    const f = calibrated(hz);
    assert.equal(sample(f, { ...neutral, smile: 0.65 }, 2, hz), 0);
    assert.equal(f.state, State.SMILE);
    assert.ok(f.rainIntensity > 0.5);
  });
  check(`sustained laugh and lost face (${hz}Hz)`, () => {
    const f = calibrated(hz);
    const bursts = sample(f, { ...neutral, smile: 0.65, jaw: 0.85, squint: 0.4 }, 2, hz);
    assert.ok(bursts >= 2 && bursts <= 4);
    assert.equal(sample(f, { found: false }, 2, hz), 0);
    assert.equal(f.state, State.NEUTRAL);
    f.reset();
    assert.equal(sample(f, { ...neutral, smile: 0.65, jaw: 0.9 }, 0.5, hz), 0);
    assert.equal(f.calibrating, true);
  });
  check(`moderate open-mouth smile triggers without exaggerated jaw (${hz}Hz)`, () => {
    const f = calibrated(hz);
    assert.ok(sample(f, { ...neutral, smile: 0.5, jaw: 0.285, squint: 0.1 }, 1, hz) >= 1);
    assert.equal(f.state, State.LAUGH);
  });
  check(`weak mouth smile with speech-like jaw changes stays below laugh (${hz}Hz)`, () => {
    const f = calibrated(hz);
    for (let i = 0; i < hz * 2; i++) {
      assert.equal(f.update({ ...neutral, smile: 0.16, jaw: i % 8 < 4 ? 0.8 : 0.1, squint: 0.1 }, 1 / hz).burst, false);
    }
    assert.notEqual(f.state, State.LAUGH);
  });
  check(`one short jaw spike during a smile does not fire (${hz}Hz)`, () => {
    const f = calibrated(hz);
    sample(f, { ...neutral, smile: 0.5 }, 0.5, hz);
    assert.equal(f.update({ ...neutral, smile: 0.5, jaw: 0.8 }, 1 / hz).burst, false);
    assert.equal(sample(f, { ...neutral, smile: 0.5 }, 0.5, hz), 0);
  });
}
function canvasMock() {
  return { context: null, cloned: null, replaced: null,
    acquire(type) { if (this.context && this.context !== type) return null; this.context = type; return {}; },
    cloneNode() { return this.cloned = canvasMock(); },
    replaceWith(fresh) { this.replaced = fresh; }
  };
}
class Legacy { constructor(c) { assert.ok(c.acquire('2d')); this.canvas = c; } setQuality() {} resize() {} }
check('GPU constructor failure uses fresh canvas for 2D', () => {
  class Broken { static probe() { return { ok: true }; } constructor(c) { c.acquire('webgl2'); throw Error('injected shader failure'); } }
  const c = canvasMock(), picked = createRenderer(c, Broken, Legacy, 390, 844);
  assert.equal(picked.canvas, c.replaced);
  assert.notEqual(picked.canvas, c);
  assert.equal(picked.canvas.context, '2d');
});
check('GPU resize failure releases context and falls back', () => {
  let disposed = false;
  class Broken { static probe() { return { ok: true }; } constructor(c) { c.acquire('webgl2'); } setQuality() {} resize() { throw Error('injected FBO failure'); } dispose() { disposed = true; } }
  assert.equal(createRenderer(canvasMock(), Broken, Legacy, 390, 844).canvas.context, '2d');
  assert.equal(disposed, true);
});
check('unsupported GPU does not acquire a context on the display canvas', () => {
  class Unsupported { static probe() { return { ok: false, reason: 'test' }; } }
  const c = canvasMock(); assert.equal(createRenderer(c, Unsupported, Legacy, 390, 844).canvas, c);
});
check('FPS reports real 10 FPS and downgrades', () => {
  const p = new PerfMonitor(); for (let i = 0; i < 80; i++) p.tick(0.1);
  assert.ok(p.fps < 11); assert.equal(p.level, 0);
});
console.log(`${passed} regression checks passed. Synthetic signals and context mocks; not camera/device acceptance.`);

check('duplicate frames cannot finish calibration', () => {
  const f=new ExpressionFSM(), input=new ExpressionInput(f);
  input.update(neutral,0);
  for(let t=16;t<2000;t+=16) assert.equal(input.update(null,t).burst,false);
  assert.equal(f.calibrating,true);assert.equal(f.calibrateProgress,0);
});
check('video freeze stops sustained bursts; new frames can resume', () => {
  const f=new ExpressionFSM(), input=new ExpressionInput(f);
  for(let t=0;t<1200;t+=20) input.update(neutral,t);
  const laugh={...neutral,smile:.65,jaw:.85,squint:.4};let bursts=0;
  for(let t=1200;t<3200;t+=20) bursts+=input.update(laugh,t).burst?1:0;
  assert.ok(bursts>=2);
  for(let t=3200;t<6200;t+=20) assert.equal(input.update(null,t).burst,false);
  assert.equal(input.tracking,false);assert.equal(f.state,State.NEUTRAL);
  for(let t=6200;t<7400;t+=20)input.update(laugh,t);
  assert.equal(f.state,State.LAUGH);
});
check('one smile inference cannot count as two confirmation frames', () => {
  const f=calibrated(), input=new ExpressionInput(f);
  input.update(neutral,0);input.update({...neutral,smile:1},100);
  for(let t=110;t<240;t+=10)input.update(null,t);
  assert.equal(f.state,State.NEUTRAL);
});
const ellipse={x:0,y:0,rx:10,ry:10,valid:true};
check('fast particle crossing whole head reflects', () => {
  const out={};assert.ok(sweepEllipse(ellipse,-30,0,30,0,1200,0,.05,.42,out));
  assert.ok(out.x<0);assert.ok(out.px<-10);
});
check('moving head pushes stationary particle', () => {
  const out={};const moving={...ellipse,x:25,prevValid:true,prevX:0,prevY:0,prevRx:10,prevRy:10};
  assert.ok(sweepEllipse(moving,20,0,20,0,0,0,.05,.42,out));
  assert.ok(out.x>0);assert.ok(out.px>35);
});
check('interior births, misses and lost faces do not bounce', () => {
  const out={};
  assert.equal(sweepEllipse(ellipse,0,0,30,0,600,0,.05,.42,out),false);
  assert.equal(sweepEllipse(ellipse,-30,20,30,20,1200,0,.05,.42,out),false);
  assert.equal(sweepEllipse({...ellipse,valid:false},-30,0,30,0,1200,0,.05,.42,out),false);
});
console.log(`${passed} total regression checks passed.`);
