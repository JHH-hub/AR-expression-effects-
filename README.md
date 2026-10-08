# 微笑落雨 · 大笑烟花

浏览器 AR 表情互动原型。开启摄像头后保持自然表情完成校准，微笑触发雨幕，大笑触发烟花，粒子与跟随头部的二维椭圆发生碰撞。

- 在线体验：https://facefx.pxlsan.cn/
- 源码：https://github.com/JHH-hub/AR-expression-effects-
- 代码版本标记：`20261008b`，控制台 `window.__ar.version` 可查看。
- Part 1 方案：`docs/part1-pipeline.md`；JSON 契约：`docs/generator.schema.json`。
- Part 2 说明及复盘：`docs/part2-demo.md`。
- 验证结果与待测项：`docs/verification.md`。

## 本地运行

静态前端，无需构建或服务端推理。在仓库目录运行 `python -m http.server 8080`，访问 `http://localhost:8080/`。摄像头需HTTPS或localhost。MediaPipe脚本、WASM及模型从CDN加载，首次使用需要联网。摄像头画面在本地处理，不上传到应用服务器。

## 验证

- 逻辑回归：`node tests/regression.mjs`，无需安装JS依赖。
- JSON契约：`pip install -r requirements-dev.txt` 后运行 `python tests/schema_contract.py`。
- 浏览器检查：`npm install`，本机安装Edge；启动 `python -m http.server 8089` 后运行 `npm run test:browser`。使用模拟摄像头，不能代表真人表情准确率。
- 连续渲染：同一服务器下运行 `npm run test:renderer`；3分钟合成场景，仅测渲染器，不含摄像头和人脸推理。

## 设计取舍

一次人脸推理同时供表情与碰撞复用。嘴角是必要证据，眼周辅助，张嘴参与大笑判定；个人基线、EMA和迟滞减少抖动。仅新识别结果推进表情状态，250毫秒无新结果即停止新触发。

WebGL2通过浮点纹理更新粒子，启动失败换独立Canvas2D降级。HIGH/MID/LOW粒子容量65536/25600/9216，DPR上限1.5/1.25/1.0；LOW隔帧推理。容量不等于持续活跃量或实测帧率。

烟花对头部的碰撞采用相对运动路径检测，处理高速穿越和头部主动移动。头部为二维椭圆，尺寸变化为近似，不是三维头发分割。页面隐藏停止推理与渲染，离开页面释放媒体轨道。Windows Chrome/Edge为首要真人验收环境，其他设备状态见验证记录。

## 部署

主分支连接现有Cloudflare Pages项目。提交推送后，需等部署完成并核对线上版本。演示人数和评论用于界面示意，未接入直播业务。
