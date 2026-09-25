/**
 * 头部碰撞体拟合。
 *
 * 把 478 点人脸网格压缩成一个 2D 椭圆，让每次碰撞检测退化为常数时间的解析判定。
 * 这个取舍是「6 万粒子还能跑满帧」的前提：逐点多边形碰撞在粒子量级上不可行，
 * 而椭圆在视觉上与头部轮廓的偏差人眼几乎不可辨。
 *
 * 椭圆定义与 GPU 端 headDist() 严格一致，避免 CPU/GPU 判定漂移。
 */

export function createEllipse() {
  return { x: 0, y: 0, rx: 0, ry: 0, valid: false };
}

/**
 * @param {Array<{x:number,y:number}>} pts 归一化关键点
 * @param {(nx:number)=>number} mapX 归一化 -> 显示坐标 X（含镜像）
 * @param {(ny:number)=>number} mapY 归一化 -> 显示坐标 Y
 * @param {object} out 复用的椭圆对象（零分配）
 * @param {number} smooth 与上一帧的插值系数，抑制网格抖动导致的碰撞体瞬移
 */
export function fitHeadEllipse(pts, mapX, mapY, out, smooth = 1) {
  if (!pts || pts.length === 0) { out.valid = false; return out; }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const x0 = mapX(minX), x1 = mapX(maxX);
  const y0 = mapY(minY), y1 = mapY(maxY);

  const cx = (x0 + x1) * 0.5;
  const rx = Math.abs(x1 - x0) * 0.5 * 1.16;
  // 网格只到额头发际线，头顶还有一截：垂直方向多扩并把中心上移
  const ry = Math.abs(y1 - y0) * 0.5 * 1.24;
  const cy = (y0 + y1) * 0.5 - ry * 0.07;

  if (!out.valid) {
    out.x = cx; out.y = cy; out.rx = rx; out.ry = ry; out.valid = true;
  } else {
    out.x += (cx - out.x) * smooth;
    out.y += (cy - out.y) * smooth;
    out.rx += (rx - out.rx) * smooth;
    out.ry += (ry - out.ry) * smooth;
  }
  return out;
}

/** CPU 侧弹性碰撞（仅降级渲染路径使用；GPU 路径在 shader 内完成） */
export function collideEllipse(e, px, py, vx, vy, restitution, out) {
  if (!e.valid || e.rx <= 0 || e.ry <= 0) return false;

  const dx = px - e.x;
  const dy = py - e.y;
  const d2 = (dx * dx) / (e.rx * e.rx) + (dy * dy) / (e.ry * e.ry);
  if (d2 >= 1) return false;

  const nx = dx / (e.rx * e.rx);
  const ny = dy / (e.ry * e.ry);
  const len = Math.hypot(nx, ny) || 1;
  const ux = nx / len;
  const uy = ny / len;

  const vn = vx * ux + vy * uy;
  out.x = (vx - 2 * vn * ux) * restitution;
  out.y = (vy - 2 * vn * uy) * restitution;

  const scale = 1 / Math.sqrt(Math.max(d2, 1e-4));
  out.px = e.x + dx * scale * 1.01;
  out.py = e.y + dy * scale * 1.01;
  return true;
}
