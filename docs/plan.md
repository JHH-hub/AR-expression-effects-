# AR Expression Effects 手机端适配执行计划

**Goal:** 确认项目可通过本地静态服务器直接运行，并将页面稳定适配常见手机竖屏与短屏尺寸。
**模板:** static
**needs_dw:** false
**needs_db:** false

---

- [x] **Task 1: 检查入口与运行依赖**

  **Files:**
  - Inspect: `index.html`
  - Inspect: `src/*.js`
  - Inspect: `src/styles.css`

  **Step 1:** 检查 ES Module、MediaPipe CDN、摄像头安全上下文和渲染降级逻辑。

  **Step 2: 验证**

  启动本地 HTTP 服务，确认页面无静态资源 404、无模块语法错误。

- [x] **Task 2: 手机尺寸与安全区适配**

  **Files:**
  - Modify: `src/styles.css`

  **Step 1:** 使用动态视口单位、安全区边距、短屏滚动和紧凑布局处理常见手机尺寸。

  **Step 2: 验证**

  在 390×844 手机视口确认启动卡片、HUD、校准层和底部按钮无裁切或横向溢出。

- [x] **Task 3: 代码合规检查**

  **Files:**
  - Inspect: `index.html`
  - Inspect: `src/*.js`

  **Step 1:** 确认项目不涉及文件上传、MongoDB 或 HR 数仓，相关硬约束不适用。

  **Step 2: 验证**

  确认 `needs_dw=false`、`needs_db=false` 与代码一致。

- [x] **Task 4: 迭代预览**

  **Step 1:** 通过本地静态服务器打开页面，并以手机视口检查首屏视觉与控制区域。

  **Step 2: 验证**

  页面可加载且浏览器控制台无项目代码错误；摄像头功能保留用户手势触发。

- [ ] **Task 5: Dockerfile 检查/生成**

  本次仅要求本地直接使用，不执行线上发布；确认纯静态项目无需 Dockerfile 即可由任意静态服务器运行。

- [ ] **Task 6: 注册发布**

  本次未要求部署，记录为不适用，不执行 `anydev publish`。
