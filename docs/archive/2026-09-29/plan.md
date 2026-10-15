# AR Expression Effects 直播特效化改造执行计划

**Goal:** 把"技术 Demo 观感"改造成 TikTok/抖音直播间礼物特效观感：人是主角（美颜+提亮）、礼物 UI 层次、连击递进、三段式爆发叙事、首屏即有反馈。
**模板:** static
**needs_dw:** false
**needs_db:** false

---

## 调研结论（驱动改造的依据）

| 直播特效行业规律 | 来源 | 当前项目的违背 |
|---|---|---|
| 人必须先好看：磨皮/提亮/暖肤是直播标配，观看时长 +37% | TikTok 直播美颜生态报告 | 画面被去饱和 0.72 + 压暗 0.80 + gamma 1.12 + 暗角 0.72，人脸是灰暗背景板 |
| 用大胆高对比色，避免灰暗/奶油色 | Effect House 爆款 5 原则 | 冷蓝雨 + 压暗底 = muddy palette |
| 关键动作必须发生在头 0.5 秒，加载即有微动画 | 同上 | 开摄像头后先空校准 1.2s，期间零反馈 |
| 礼物特效 = 视觉层 + 交互层 + 工程层；需横幅/连击/徽章 | 抖音礼物特效系统设计 | 只有 FPS/粒子数/推理 ms 的工程师仪表盘 |
| 节奏三段式：登场绽放 → 高潮 → 余韵消散 | 礼物动效拆解（8s 结构） | burst 是无层次一次性爆发 |
| 触发时应伴随轻微震动反馈提升成就感 | 同上 | 只有 shock ring，无镜头位移 |
| 摩擦力归零：一个核心动作，无教程 | Effect House 爆款 5 原则 | 启动页大段说明 + 三个并列按钮 |

---

- [x] **Task 1: 美颜与画面提亮（合成着色器）**

  **Files:**
  - Modify: `src/shaders.js`（`COMPOSITE_FS`）
  - Modify: `src/glRenderer.js`（传入美颜 uniform）

  **Step 1:** 在 `COMPOSITE_FS` 增加轻量磨皮：对 video 做 5-tap 十字采样求均值，用亮度差做 detail-preserving 混合（只柔化低频，保住眼睛/嘴唇边缘）。

  **Step 2:** 摄像头层调色改为直播取向：去掉去饱和与压暗，改为提亮 + 暖肤 + 轻微提饱和；暗角从 0.72 降到 0.34。

  **Step 3: 验证** 页面加载无 shader 编译错误（`window.__ar.backend` 为 WebGL2）。

- [x] **Task 2: 连击系统与三段式爆发叙事**

  **Files:**
  - Modify: `src/main.js`
  - Modify: `src/expressionFSM.js`

  **Step 1:** 新增 combo 计数：连续大笑每次 burst 累加，3.2s 无触发则清零。

  **Step 2:** burst 改三段式：登场吸入闪光 → 主爆 → 余韵金粉，按 combo 提升规模、bloom、震动幅度。

  **Step 3: 验证** 控制台调用 `window.__ar.combo` 可读到连击值。

- [x] **Task 3: 镜头震动与礼物级氛围**

  **Files:**
  - Modify: `src/shaders.js`（`COMPOSITE_FS` 加 `uShakeOffset`）
  - Modify: `src/glRenderer.js`
  - Modify: `src/main.js`

  **Step 1:** 在合成阶段对采样 uv 做衰减震动偏移（不触发 layout，零重排）。

  **Step 2:** combo 越高震动幅度越大，上限设硬顶避免眩晕。

  **Step 3: 验证** 手动放一发后画面有短促抖动且 0.4s 内收敛。

- [x] **Task 4: 直播间 UI 层（礼物横幅 / 连击 / 主播卡 / 飘心）**

  **Files:**
  - Modify: `index.html`
  - Modify: `src/styles.css`
  - Modify: `src/ui.js`

  **Step 1:** 顶部左改为主播卡（头像圈 + 昵称 + LIVE 徽章 + 观众数），技术面板收进"性能"开关。

  **Step 2:** 新增礼物横幅（图标 + 礼物名 + `xN` 连击数字弹跳）与右下角飘心流。

  **Step 3:** 底部控制条改直播风格圆形图标按钮，主按钮做礼物金色。

  **Step 4: 验证** 手机视口 390×844 与 360×640 无溢出、无遮挡人脸中心区。

- [x] **Task 5: 首屏即时反馈**

  **Files:**
  - Modify: `src/main.js`
  - Modify: `src/ui.js`
  - Modify: `index.html`

  **Step 1:** 校准期间就渲染环绕金粉与呼吸光环，不再空屏；校准时长 1.2s → 0.9s。

  **Step 2:** 启动页精简为一句话价值点 + 单个主行动按钮。

  **Step 3: 验证** 摄像头授权后 0.5s 内画面已有可见动效。

- [x] **Task 6: 代码合规检查**

  确认无文件上传、无 MongoDB、无 HR 数仓访问，`needsDw=false` / `needsDb=false` 与代码一致。

- [x] **Task 7: 迭代预览**

  本地静态服务器 + 手机视口实测，输出预览供用户确认。

- [ ] **Task 8: Dockerfile 检查/生成**

  仅在用户确认发布后执行。

- [ ] **Task 9: 注册发布**

  仅在用户确认发布后执行。
