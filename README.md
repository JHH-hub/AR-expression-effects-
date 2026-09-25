# Smile to Rain · Laugh to Fireworks

> AR 表情互动原型：摄像头实时识别表情 —— **微笑时屏幕下雨，大笑时烟花炸开**，
> 且烟花/雨滴粒子会与用户**头部发生真实物理碰撞反弹**。

- **Live Demo**：`<部署后填写>`
- **Source Code**：`<仓库 Public 后填写>`
- 纯前端、零构建、零后端：所有画面与推理都在浏览器本地完成，不上传任何数据。

---

## 1. 交互定义（把 PM 的模糊创意翻译成可验收的工程规格）

| PM 的原话 | 工程化定义 | 判定信号 |
| --- | --- | --- |
| 用户微笑 | 屏幕下雨，雨量随微笑强度连续变化 | `(mouthSmileLeft + mouthSmileRight) / 2` |
| 大笑 | 烟花爆开，持续大笑时按节奏追加 | `jawOpen × (0.45 + 0.55 × smile)` |
| 与头部物理碰撞 | 粒子撞到头部椭圆后按法线弹性反弹 | 478 点人脸网格拟合的头部椭圆 |

**为什么大笑不是只看 `jawOpen`**：只张嘴可能是说话、打哈欠、唱歌。
因此大笑判定强制要求「**张嘴 × 嘴角上扬**」同时成立，这是把误触发率压下来的关键一步。

---

## 2. 架构

```
camera ──► FaceLandmarker (WASM/GPU, 一次推理)
              │  ├─ 52 维 blendshape ──► ExpressionFSM ──► 状态: NEUTRAL / SMILE / LAUGH
              │                              │                    │
              │                              │                    ├─► RainField   (雨量 = 微笑强度)
              │                              │                    └─► SparkPool   (大笑 burst 烟花)
              │                              └─► PerfMonitor (fps → 算力预算)
              └─ 478 点 face mesh ──► fitHeadEllipse ──► 头部椭圆 ──► collideEllipse (粒子反弹)
                                                                            │
                                                             Canvas 2D 渲染 ◄┘
```

**核心：一次推理同时供表情判定与碰撞体使用**，不叠加第二个人脸模型，这是 ROI 的底线。

---

## 3. 性能策略（性能红线）

| 手段 | 解决的问题 | 收益 |
| --- | --- | --- |
| SoA 数组 + 空闲索引栈的对象池 | 每帧 `new Particle()` 造成的 GC 抖动 | 运行时**零分配**，池满即丢弃不扩容 |
| 启动时烘焙 16 张色相 sprite | 每帧 `createRadialGradient` 极慢 | 运行时只剩 `drawImage` |
| 雨滴/拖尾各用**一次** `beginPath + stroke` 批量绘制 | 上千次 stroke 调用开销 | 每条特效每帧仅 1 次绘制调用 |
| `video.currentTime` 未变则跳过推理 | 静止画面重复推理 | 空转算力直接归零 |
| `PerfMonitor` 三级自适应降级 | 低端机掉帧 | 自动收紧粒子上限 / DPR / 推理频率 |
| HUD DOM 更新节流到 ~8Hz | DOM 写入 + 重排拖累主线程 | 主线程几乎只做渲染 |
| 页面隐藏即停推理与物理 | 后台偷跑耗电 | 电量与算力双止损 |
| 粒子溅射每帧配额 | 撞头→生粒子→再撞头的雪崩 | 粒子数有硬上限 |

**自适应预算表**（`src/perf.js`，滞后阈值 46/56 fps，避免抖动）：

| Level | 雨滴上限 | 火花上限 | 推理频率 | 渲染 DPR |
| --- | --- | --- | --- | --- |
| HIGH | 300 | 560 | 每帧 | ≤1.5 |
| MID | 180 | 320 | 每帧 | ≤1.25 |
| LOW | 90 | 160 | 隔帧 | 1.0 |

---

## 4. 表情状态机的三重抗抖动

1. **EMA 平滑**：单帧模型输出噪声大，直接阈值会让特效闪烁；平滑系数做了帧率无关处理。
2. **迟滞（hysteresis）**：进入阈值 > 退出阈值，防止在临界点反复横跳（0.30/0.17）。
3. **连续帧确认**：进入需连续 3 帧（~50ms），退出需连续 10 帧（~165ms）——
   退出比进入更"粘"，否则雨会断断续续地下。

---

## 5. 本地运行

```bash
# 任意静态服务器均可，必须走 http(s) 而非 file://（ES module + 摄像头权限）
npx serve .
# 或
python -m http.server 8080
```

> 摄像头只在 **HTTPS / localhost** 下可用；`file://` 打开会同时卡在模块加载和权限上。
> 首次加载会从 CDN 拉取 MediaPipe WASM 与 `face_landmarker.task`（约 3MB），请保持联网。

## 6. 目录结构

```
index.html            页面与 UI 骨架（importmap 引入 MediaPipe ESM）
src/
  main.js             主循环编排与坐标映射（镜像 + cover 的唯一真相）
  faceTracker.js      FaceLandmarker 封装（GPU→CPU 降级、静止帧跳过推理）
  expressionFSM.js    表情状态机（平滑 + 迟滞 + 连续帧确认）
  particles.js        SoA 粒子池 + 雨场 + 预烘焙 sprite
  collision.js        头部椭圆拟合与弹性碰撞
  perf.js             FPS → 算力预算的自动降级
  styles.css          UI 样式
```

## 7. 已知边界（Edge Cases）

- 未授权摄像头 / 非安全上下文 / 模型 CDN 不可达：均有明确降级文案，不白屏。
- 多人同框：只追踪 1 张脸（`numFaces: 1`），避免特效归属混乱与算力翻倍。
- 快速转头或强逆光：网格抖动时头部椭圆做 0.35 系数插值，碰撞体不会瞬移。
- 极端大笑导致的连续 burst：有 550ms 冷却与持续间隔，避免粒子瞬时打满池。

---

## 8. Vibecoding 复盘

**最大的性能陷阱**：AI 首版把粒子写成每帧 `new Particle()` + 每帧 `createRadialGradient()` 逐个绘制，
并逐帧写 HUD DOM。逻辑完全正确，但在中端机上直接掉到 25fps 且周期性卡顿——
GC 抖动和渐变构建吃掉了全部帧预算，属于典型的「功能对、性能错」。

**架构调整**：粒子改为预分配 `Float32Array` SoA + 空闲索引栈（运行期零分配），
渐变 sprite 启动时烘焙 16 张离屏 canvas，雨滴与拖尾各合并为一次 `stroke`，HUD 节流到 8Hz，
并由 `PerfMonitor` 按帧率自动下调粒子上限与推理频率。

**纠偏 Prompt**：

> 渲染循环内禁止任何对象分配、禁止 `createRadialGradient`、禁止逐帧写 DOM。
> 把粒子改成预分配的 Float32Array SoA + 空闲索引栈（池满即丢弃，不得扩容）；
> 彩色光点在启动时烘焙成 16 张离屏 sprite，运行时只 `drawImage`；
> 雨滴与拖尾各自合并成一次 `beginPath/stroke`；HUD 节流到 8Hz。
> 逐条给出修改后每帧的堆分配次数，必须为 0。
