/**
 * 人脸追踪：MediaPipe FaceLandmarker（WASM + GPU delegate）。
 *
 * 一次推理同时产出三类数据，下游全部复用，不叠加第二个模型：
 *   1. 52 维 blendshape  -> 表情判定
 *   2. 478 点面部网格     -> 头部碰撞体
 *   3. 关键锚点（嘴部）   -> 特效发射源，让特效「长在脸上」而非浮在屏幕上
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Face Mesh 关键点索引
const LM = {
  upperLipInner: 13,
  lowerLipInner: 14,
  mouthLeft: 61,
  mouthRight: 291,
  foreheadTop: 10,
  chin: 152,
};

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.stream = null;
    this._nameIndex = null;
    this._lastVideoTime = -1;
    this._ts = 0;
    this.lastInferMs = 0;
    this.delegate = '-';
  }

  async load() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    const opts = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    };
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts);
      this.delegate = 'GPU';
    } catch (e) {
      // 部分安卓 WebGL 受限，降级 CPU 保证功能可用
      opts.baseOptions.delegate = 'CPU';
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts);
      this.delegate = 'CPU';
    }
    return this.landmarker;
  }

  /** 必须由用户手势触发（浏览器安全策略） */
  async start(video) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
    if (video.readyState < 2) {
      await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
    }
    return this.stream;
  }

  /**
   * @returns {null | {found:boolean, smile:number, jaw:number, squint:number, pucker:number, pts:Array, anchors:Object}}
   *          null 表示本帧视频未推进，沿用上一帧结果（省掉 100% 的无效推理）
   */
  detect(video) {
    if (!this.landmarker || video.readyState < 2) return null;
    if (video.currentTime === this._lastVideoTime) return null;
    this._lastVideoTime = video.currentTime;

    const ts = Math.max(this._ts + 1, performance.now());
    this._ts = ts;

    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(video, ts);
    this.lastInferMs = performance.now() - t0;

    const shapes = res.faceBlendshapes && res.faceBlendshapes[0];
    const pts = res.faceLandmarks && res.faceLandmarks[0];
    if (!shapes || !pts) {
      return { found: false, smile: 0, jaw: 0, squint: 0, pucker: 0, pts: null, anchors: null };
    }

    if (!this._nameIndex) {
      this._nameIndex = new Map();
      shapes.categories.forEach((c, i) => this._nameIndex.set(c.categoryName, i));
    }
    const g = (n) => {
      const i = this._nameIndex.get(n);
      return i === undefined ? 0 : shapes.categories[i].score;
    };

    const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) * 0.5;
    // 眼周收缩（Duchenne marker）：真笑一定带眼周动作，用它抬高真笑、压低假笑
    const squint = (g('cheekSquintLeft') + g('cheekSquintRight')) * 0.5;
    const jaw = g('jawOpen');
    // 撅嘴/闭嘴动作用于排除「说话」「嘟嘴」被误判成笑
    const pucker = Math.max(g('mouthPucker'), g('mouthFunnel'));

    const up = pts[LM.upperLipInner];
    const lo = pts[LM.lowerLipInner];
    const ml = pts[LM.mouthLeft];
    const mr = pts[LM.mouthRight];

    const anchors = {
      mouth: { x: (up.x + lo.x) * 0.5, y: (up.y + lo.y) * 0.5 },
      mouthL: { x: ml.x, y: ml.y },
      mouthR: { x: mr.x, y: mr.y },
      forehead: pts[LM.foreheadTop],
      chin: pts[LM.chin],
    };

    return { found: true, smile, jaw, squint, pucker, pts, anchors };
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
