/** A canvas cannot switch context type after WebGL acquisition. */
export function createRenderer(canvas, GL, Legacy, width, height) {
  const probe = GL.probe();
  let gpu;
  if (probe.ok) {
    try {
      gpu = new GL(canvas);
      gpu.setQuality(2);
      gpu.resize(width, height);
      return { canvas, renderer: gpu, backend: 'WebGL2 · GPU 粒子' };
    } catch (error) {
      console.warn('[renderer] WebGL2 初始化失败，切换独立 Canvas2D：', error);
      // Detach the failed context and its listeners; explicitly release GPU resources.
      gpu?.dispose();
      const fresh = canvas.cloneNode(false);
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
  } else {
    console.warn('[renderer] 降级原因：', probe.reason);
  }
  const renderer = new Legacy(canvas);
  renderer.setQuality(2);
  renderer.resize(width, height);
  return { canvas, renderer, backend: 'Canvas2D · 降级模式' };
}
