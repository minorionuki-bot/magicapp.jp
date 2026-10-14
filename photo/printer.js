// 白紙カードの写真に、カードの印刷を焼き込む（ブラウザ版）。
// iOSアプリの MagicPhoto/Printing/CardPrinter.swift・ImageMath.swift をそのまま移したもの。
// 仕組みと判断の理由は CLAUDE.md と Swift 側のコメントを参照。**Swift 側を直したら、こちらも同じように直すこと。**
//
// Swift 版との違い：Vision（Apple標準の四角形検出）はブラウザにないので使わない。
// 自前の「白くて四角い塊」の候補だけで、試し撮り18枚の結果が Vision ありと同じことを確かめてある。
//
// 画像は { width, height, data: Uint8ClampedArray(RGBA) } で受け渡す（canvas の ImageData と同じ形）。

/** 確認用：globalThis.MAGICPHOTO_DEBUG を true にすると、検出の途中経過を出す */
const debugLog = (...a) => { if (globalThis.MAGICPHOTO_DEBUG) console.log(...a); };

export const CARD_W = 1260;   // 63 x 88 mm の比
export const CARD_H = 1760;

// MARK: - 明るさの変換（sRGB ⇄ 線形）

function fromSRGB(x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
function toSRGB(x) {
  x = Math.max(0, Math.min(1, x));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
const FROM8 = new Float32Array(256).map((_, i) => fromSRGB(i / 255));
const TO8 = new Uint8Array(4096).map((_, i) => Math.max(0, Math.min(255, Math.round(toSRGB(i / 4095) * 255))));
function to8bit(x) { return TO8[Math.round(Math.max(0, Math.min(1, x)) * 4095)]; }

// MARK: - カードの絵柄

/** 実物のカードから切り出した「インクの透過率」（線形）。image は CARD_W x CARD_H の RGBA */
export function makeCardFace(image) {
  const n = CARD_W * CARD_H, d = image.data;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { r[i] = FROM8[d[4 * i]]; g[i] = FROM8[d[4 * i + 1]]; b[i] = FROM8[d[4 * i + 2]]; }
  return { r, g, b };
}

// MARK: - ぼかし（箱型ぼかしを3回重ねたガウスぼかしの近似）

function boxSizes(sigma, n = 3) {
  const wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl -= 1;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function boxBlurH(s, d, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += s[row + Math.min(Math.max(k, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      d[row + x] = acc * inv;
      acc += s[row + Math.min(x + r + 1, w - 1)] - s[row + Math.max(x - r, 0)];
    }
  }
}

function boxBlurV(s, d, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += s[Math.min(Math.max(k, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      d[y * w + x] = acc * inv;
      acc += s[Math.min(y + r + 1, h - 1) * w + x] - s[Math.max(y - r, 0) * w + x];
    }
  }
}

/** a をその場でぼかす */
function gaussianBlur(a, w, h, sigma) {
  if (sigma < 0.5) return;
  const tmp = new Float32Array(a.length);
  for (const size of boxSizes(sigma)) {
    if (size <= 1) continue;
    const r = (size - 1) >> 1;
    boxBlurH(a, tmp, w, h, r);
    boxBlurV(tmp, a, w, h, r);
  }
}

// MARK: - 2値画像の処理

/** 指定した半径で広げる（正方形）。結果は 0 か 1。窓の中の「0 以外の数」を数えながらずらす（半径によらず同じ手間） */
function dilate(a, w, h, r) {
  if (r <= 0) return;
  const tmp = new Uint8Array(a.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let k = 0; k < Math.min(r, w); k++) if (a[row + k]) count++;
    for (let x = 0; x < w; x++) {
      if (x + r < w && a[row + x + r]) count++;
      if (x - r - 1 >= 0 && a[row + x - r - 1]) count--;
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let k = 0; k < Math.min(r, h); k++) if (tmp[k * w + x]) count++;
    for (let y = 0; y < h; y++) {
      if (y + r < h && tmp[(y + r) * w + x]) count++;
      if (y - r - 1 >= 0 && tmp[(y - r - 1) * w + x]) count--;
      a[y * w + x] = count > 0 ? 1 : 0;
    }
  }
}

/** 指定した半径で縮める（正方形） */
function erode(a, w, h, r) {
  for (let i = 0; i < a.length; i++) a[i] = a[i] ? 0 : 1;
  dilate(a, w, h, r);
  for (let i = 0; i < a.length; i++) a[i] = a[i] ? 0 : 1;
}

/** 正方形の範囲の最大値 */
function maxFilter(a, w, h, r) {
  if (r <= 0) return;
  const tmp = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) if (a[y * w + k] > m) m = a[y * w + k];
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      a[y * w + x] = m;
    }
  }
}

// MARK: - 縮小して計算する（なめらかに変わる量だけに使う。iPhone の Safari で保存までに4秒以上かかったので速くする）

/** f×f の区画ごとに、最大値（max）か平均にまとめる */
function shrink(a, w, h, f, max) {
  const dw = Math.ceil(w / f), dh = Math.ceil(h / f), d = new Float32Array(dw * dh), c = new Float32Array(dw * dh);
  if (max) d.fill(-Infinity);
  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * dw;
    for (let x = 0; x < w; x++) {
      const j = row + ((x / f) | 0), v = a[y * w + x];
      if (max) { if (v > d[j]) d[j] = v; } else { d[j] += v; c[j]++; }
    }
  }
  if (!max) for (let j = 0; j < dw * dh; j++) d[j] /= Math.max(1, c[j]);
  return { d, dw, dh };
}

/** shrink したものを元の大きさに戻す（となりの区画となめらかにつなぐ） */
function expand(s, f, w, h, only = null) {
  const { d, dw, dh } = s, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(dh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.min(dh - 2, Math.floor(fy)), ay = Math.min(1, fy - Math.max(0, y0));
    const r0 = Math.max(0, y0) * dw, r1 = Math.min(dh - 1, Math.max(0, y0) + 1) * dw;
    for (let x = 0; x < w; x++) {
      if (only && !only[y * w + x]) continue;   // 必要な画素だけ（only があるとき）
      const fx = Math.min(dw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = Math.min(dw - 2, Math.floor(fx)), xa = Math.max(0, x0), xb = Math.min(dw - 1, xa + 1), ax = Math.min(1, fx - xa);
      out[y * w + x] = (d[r0 + xa] * (1 - ax) + d[r0 + xb] * ax) * (1 - ay) + (d[r1 + xa] * (1 - ax) + d[r1 + xb] * ax) * ay;
    }
  }
  return out;
}

/** つながった領域（8近傍）のうち、面積が minArea 以上のものの画素の番号 */
function regions(a, w, h, minArea) {
  const seen = new Uint8Array(a.length);
  const result = [];
  const stack = [];
  for (let start = 0; start < a.length; start++) {
    if (!a[start] || seen[start]) continue;
    const members = [];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (a[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (members.length >= minArea) result.push(members);
  }
  return result;
}

/** 周りを region に囲まれた穴（画像の端とつながっていない部分）を埋め、埋めた画素の数を返す */
function fillEnclosedHoles(region, w, h) {
  const outside = new Uint8Array(region.length);
  const stack = [];
  for (let i = 0; i < region.length; i++) {
    if (region[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { outside[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !region[j] && !outside[j]) { outside[j] = 1; stack.push(j); }
  }
  let filled = 0;
  for (let i = 0; i < region.length; i++) if (!region[i] && !outside[i]) { region[i] = 1; filled++; }
  return filled;
}

/** 画素の集まり（番号）の穴を埋めたときの面積 */
function filledArea(members, w) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of members) { const x = i % w, y = (i / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
  const local = new Uint8Array(bw * bh);
  for (const i of members) local[(((i / w) | 0) - y0 + 1) * bw + (i % w - x0 + 1)] = 1;
  return members.length + fillEnclosedHoles(local, bw, bh);
}

/** つながった領域のうち、面積が minArea 以上のものだけを残す */
function keepLargeRegions(a, w, h, minArea) {
  const out = new Uint8Array(a.length);
  for (const r of regions(a, w, h, minArea)) for (const i of r) out[i] = 1;
  return out;
}

/** region の「穴」（inside の範囲の外とつながっていない、region でない部分）を埋める */
function fillHoles(region, inside, w, h) {
  const reached = new Uint8Array(region.length);
  const stack = [];
  for (let i = 0; i < region.length; i++) {
    if (region[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (inside[i] < 0.5 || x === 0 || y === 0 || x === w - 1 || y === h - 1) { reached[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !region[j] && !reached[j]) { reached[j] = 1; stack.push(j); }
  }
  for (let i = 0; i < region.length; i++) if (!region[i] && !reached[i]) region[i] = 1;
}

/** モルフォロジー再構成：marker を、limit を超えない範囲で、隣へ隣へと広げられるだけ広げる */
function reconstructByDilation(marker, limit, w, h) {
  for (let iter = 0; iter < 100; iter++) {
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = marker[i];
        if (x > 0) v = Math.max(v, marker[i - 1]);
        if (y > 0) {
          v = Math.max(v, marker[i - w]);
          if (x > 0) v = Math.max(v, marker[i - w - 1]);
          if (x < w - 1) v = Math.max(v, marker[i - w + 1]);
        }
        v = Math.min(v, limit[i]);
        if (v > marker[i]) { marker[i] = v; changed = true; }
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = marker[i];
        if (x < w - 1) v = Math.max(v, marker[i + 1]);
        if (y < h - 1) {
          v = Math.max(v, marker[i + w]);
          if (x < w - 1) v = Math.max(v, marker[i + w + 1]);
          if (x > 0) v = Math.max(v, marker[i + w - 1]);
        }
        v = Math.min(v, limit[i]);
        if (v > marker[i]) { marker[i] = v; changed = true; }
      }
    }
    if (!changed) return;
  }
}

// MARK: - 射影変換（四角形 ⇄ 四角形）

/** from の4点を to の4点に移す変換。点は {x, y} */
function homography(from, to) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const x = from[i].x, y = from[i].y, u = to[i].x, v = to[i].y;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 9; k++) a[r][k] -= f * a[c][k];
    }
  }
  const m = a.map((row, i) => row[8] / row[i]);
  m.push(1);
  return (x, y) => {
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  };
}

// MARK: - 幾何

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const len = (a) => Math.hypot(a.x, a.y);
const cross = (a, b) => a.x * b.y - a.y * b.x;

/** 点 p を通り向き d の直線 */
function lineIntersection(l1, l2) {
  const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
  return add(l1.p, mul(l1.d, t));
}

function lineDistance(l, q) { return Math.abs((q.x - l.p.x) * l.d.y - (q.y - l.p.y) * l.d.x); }

/** 点の集まりに直線を当てはめる（主成分の向き） */
function fitLine(pts) {
  if (pts.length < 2) return null;
  let cx = 0, cy = 0;
  for (const q of pts) { cx += q.x; cy += q.y; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const q of pts) {
    sxx += (q.x - cx) * (q.x - cx);
    sxy += (q.x - cx) * (q.y - cy);
    syy += (q.y - cy) * (q.y - cy);
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: cx, y: cy }, d: { x: Math.cos(angle), y: Math.sin(angle) } };
}

/** 「ぴったり一直線に並ぶ点がいちばん多い線」を選んでから当てはめる（RANSAC） */
function robustFit(points, tolerance = 1.2) {
  if (points.length < 8) return null;
  const step = Math.max(1, Math.floor(points.length / 80));
  const sample = [];
  for (let i = 0; i < points.length; i += step) sample.push(points[i]);
  let bestCount = 0, bestLine = null;
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const d = sub(sample[j], sample[i]);
      const L = len(d);
      if (L <= 10) continue;
      const l = { p: sample[i], d: mul(d, 1 / L) };
      let count = 0;
      for (const p of points) if (lineDistance(l, p) <= tolerance) count++;
      if (count > bestCount) { bestCount = count; bestLine = l; }
    }
  }
  if (!bestLine) return null;
  const inliers = points.filter((p) => lineDistance(bestLine, p) <= tolerance);
  if (inliers.length < 6) return null;
  let line = fitLine(inliers);
  const again = points.filter((p) => lineDistance(line, p) <= tolerance);
  if (again.length >= 6) line = fitLine(again);
  return line;
}

function convexHull(points) {
  const p = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  if (p.length <= 2) return p;
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(q, lower[lower.length - 2])) <= 0) lower.pop();
    lower.push(q);
  }
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k];
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(q, upper[upper.length - 2])) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** 点の集まりを囲む最小の長方形。四隅は時計回り・左上から */
function minAreaRect(pts) {
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const e = sub(hull[(i + 1) % hull.length], hull[i]);
    const L = len(e);
    if (L < 1e-6) continue;
    const d = mul(e, 1 / L), n = { x: -d.y, y: d.x };
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of hull) {
      const u = p.x * d.x + p.y * d.y, v = p.x * n.x + p.y * n.y;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      best = { area, c: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => add(mul(d, u), mul(n, v))) };
    }
  }
  const c = best.c;
  const center = mul(c.reduce(add, { x: 0, y: 0 }), 0.25);
  c.sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  let start = 0;
  for (let i = 1; i < 4; i++) if (c[i].x + c[i].y < c[start].x + c[start].y) start = i;
  return [0, 1, 2, 3].map((k) => c[(start + k) % 4]);
}

// MARK: - 画像の縮小（検出用）

/** 長辺 maxSide に縮めた画像（面積平均）。canvas のないところ（テスト）でも使えるように自前で行う */
export function downscale(image, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
  if (scale === 1) return { image, scale: 1 };
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = image.width / w, sy = image.height / h, src = image.data, W = image.width;
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = ya; yy < yb; yy++) {
        for (let xx = xa; xx < xb; xx++) {
          const k = 4 * (yy * W + xx);
          r += src[k]; g += src[k + 1]; b += src[k + 2]; c++;
        }
      }
      const o = 4 * (y * w + x);
      out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c; out[o + 3] = 255;
    }
  }
  return { image: { width: w, height: h, data: out }, scale: w / image.width };
}

// MARK: - カードを探す

/**
 * 写真の中の白紙カードの四隅（左上・右上・右下・左下、写真の画素座標）。見つからなければ null。
 * small は長辺1200pxに縮めた画像、scale はその縮小率（small の幅 ÷ 元の幅）
 */
export function findCard(small, scale, hint = null) {
  const w = small.width, h = small.height, px = small.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
  gaussianBlur(lum, w, h, 1.2);
  const edges = edgeMap(lum, w, h);

  let best = null, bestIsTapped = false;
  const seeds = whiteBlobSeeds(small, edges);
  debugLog('white blob seeds', seeds.length);
  // hint：タップで示された「カードはここ」（写真に対する割合 0〜1）。理由は Swift 側
  const hintPoint = hint ? { x: hint.x * w, y: hint.y * h } : null;
  let tapSeed = hintPoint ? tappedSeed(small, edges, hintPoint) : null;
  if (tapSeed) seeds.unshift(tapSeed);
  for (const q of seeds) {
    const ps = paperScore(q, small);
    const hinted = hintPoint ? contains(q, hintPoint) : false;
    debugLog('seed', q.map((p) => `[${Math.round(p.x / scale)},${Math.round(p.y / scale)}]`).join(' '), 'paper', ps, hinted ? '(tapped)' : '');
    // 内側が白い紙（白紙・数字札）か、縁が白い紙（絵札）。タップで示された候補は基準を緩める
    if (!ps || !(ps.inner > 0.6 || ps.rim > 0.75 || (hinted && Math.max(ps.inner, ps.rim) > 0.3))) continue;
    const region = regionQuad(q, small, edges, ps.paper);
    debugLog('  region', region && { fill: region.fill, area: region.area });
    if (!region) continue;
    const [tl, tr, br, bl] = region.quad;
    // 縦横比は向かい合う辺の平均で測る（長い方 ÷ 短い方。カードは 88÷63 = 1.40）
    const sideA = (len(sub(tr, tl)) + len(sub(br, bl))) / 2;
    const sideB = (len(sub(bl, tl)) + len(sub(br, tr))) / 2;
    const aspect = Math.max(sideA, sideB) / Math.max(1, Math.min(sideA, sideB));
    // 写真の端に接している四角は、端で切れた壁などなので候補にしない
    const margin = 0.01 * Math.max(w, h);
    const touchesBorder = region.quad.some((p) => p.x < margin || p.y < margin || p.x > w - margin || p.y > h - margin);
    debugLog('  quad', region.quad.map((p) => `[${Math.round(p.x / scale)},${Math.round(p.y / scale)}]`).join(' '), 'aspect', aspect.toFixed(2), 'border', touchesBorder);
    // 指で角が欠けた、印刷されたカードでも通るように 0.65。中央に近いものを優先する（理由は Swift 側）
    const tapped = hintPoint ? contains(region.quad, hintPoint) : false;
    if (region.fill <= (tapped ? 0.5 : 0.65) || touchesBorder || aspect < 1.1 || aspect > 1.7) continue;
    const likeCard = Math.exp(-Math.pow((aspect - 1.4) / 0.2, 2));
    const cx = region.quad.reduce((a, p) => a + p.x, 0) / 4, cy = region.quad.reduce((a, p) => a + p.y, 0) / 4;
    const off = Math.hypot(cx - w / 2, cy - h / 2) / (Math.hypot(w, h) / 2);
    const nearCenter = Math.exp(-Math.pow(off / 0.5, 2));
    const score = region.area * Math.pow(region.fill, 4) * likeCard * nearCenter * (tapped ? 100 : 1);
    if (!best || score > best.score) { best = { score, quad: region.quad, paper: ps.paper }; bestIsTapped = tapped; }
  }
  // 絵札は紙が縁の細い輪だけなので、塗り広げても四角が埋まらない。タップの近くで白い縁が四角く続いていたら
  // その四角を使う。タップがなく何も見つからないときは、画面の真ん中をタップしたものとして探す（理由は Swift 側）
  if (!hintPoint && !best) tapSeed = tappedSeed(small, edges, { x: w / 2, y: h / 2 });
  if (!bestIsTapped && (hintPoint || !best) && tapSeed) {
    const ps = paperScore(tapSeed, small);
    if (ps) { debugLog('use tapped seed as is'); best = { score: 0, quad: tapSeed, paper: ps.paper }; }
  }
  if (!best) return null;

  const fine = refine(best.quad, lum, w, h, best.paper) || best.quad;
  let corners = fine.map((p) => mul(p, 1 / scale));
  // 縦長のカードとして扱う（短い辺が上）
  if (len(sub(corners[1], corners[0])) > len(sub(corners[3], corners[0]))) {
    corners = [corners[1], corners[2], corners[3], corners[0]];
  }
  return corners;
}

/** 明るさの境目（輪郭線）。白い椅子や壁、白っぽく写った手とカードを切り分けるのに使う */
function edgeMap(lum, w, h) {
  const e = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1]) - (lum[i - w - 1] + 2 * lum[i - 1] + lum[i + w - 1]);
      const gy = (lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1]) - (lum[i - w - 1] + 2 * lum[i - w] + lum[i - w + 1]);
      if (Math.abs(gx) + Math.abs(gy) > 25) e[i] = 1;
    }
  }
  dilate(e, w, h, 1);
  return e;
}

/** 白っぽく、明るさの境目で区切られた塊を、それを囲む最小の長方形として返す（カード探しの候補） */
function whiteBlobSeeds(small, edges) {
  const w = small.width, h = small.height, px = small.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (edges[i]) continue;
    const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 120 && (mx - mn) / mx < 0.22) mask[i] = 1;
  }
  const seeds = [];
  for (const blob of regions(mask, w, h, Math.floor(w * h / 250))) {
    const pts = blob.map((i) => ({ x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5 }));
    const rect = minAreaRect(pts);
    if (!rect) continue;
    const a = len(sub(rect[1], rect[0])), b = len(sub(rect[3], rect[0]));
    const short = Math.min(a, b), long = Math.max(a, b);
    debugLog('blob', blob.length, 'short', short.toFixed(1), 'long', long.toFixed(1), 'fill', (blob.length / (short * long)).toFixed(3));
    // 候補を絞るための目安。指や強い影で欠けると 0.65 くらいまで下がるので緩めにとる（理由は Swift 側）
    if (short <= 8 || long / short >= 2 || filledArea(blob, w) / (short * long) <= 0.5) continue;
    seeds.push(rect);
  }
  return seeds;
}

function quadPoint(q, u, v) {
  const [tl, tr, br, bl] = q;
  const top = add(tl, mul(sub(tr, tl), u)), bottom = add(bl, mul(sub(br, bl), u));
  return add(top, mul(sub(bottom, top), v));
}

/** 四角形の内側（inner）と縁の帯（rim）が白い紙らしい割合と、紙の明るさ */
function paperScore(q, small) {
  const px = small.data;
  const sample = (u, v) => {
    const p = quadPoint(q, u, v);
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= small.width || y >= small.height) return null;
    const k = 4 * (y * small.width + x);
    const r = px[k], g = px[k + 1], b = px[k + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return { white: mx > 110 && (mx - mn) / mx < 0.22, lum: 0.299 * r + 0.587 * g + 0.114 * b };
  };
  let innerHits = 0, innerTotal = 0, rimHits = 0, rimTotal = 0;
  const white = [], all = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      const s = sample(0.2 + 0.6 * i / 11, 0.2 + 0.6 * j / 11);
      if (!s) continue;
      innerTotal++;
      all.push(s.lum);
      if (s.white) { innerHits++; white.push(s.lum); }
    }
  }
  for (let k = 0; k < 16; k++) {
    const t = 0.15 + 0.7 * k / 15;
    for (const [u, v] of [[t, 0.06], [t, 0.94], [0.06, t], [0.94, t]]) {
      const s = sample(u, v);
      if (!s) continue;
      rimTotal++;
      if (s.white) { rimHits++; white.push(s.lum); }
    }
  }
  if (!innerTotal || !rimTotal) return null;
  const source = (white.length >= 8 ? white : all).sort((a, b) => a - b);
  return { inner: innerHits / innerTotal, rim: rimHits / rimTotal, paper: source[source.length >> 1] };
}

/** 点が四角形の内側にあるか */
function contains(q, p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const k = cross(sub(q[(i + 1) % 4], q[i]), sub(p, q[i]));
    if (sign === 0) sign = k; else if (k * sign < 0) return false;
  }
  return true;
}

/** タップの近くの白い塊（境目で区切ったもの）を近い順につなぎ、縁が四角く続く組み合わせを探す（理由は Swift 側） */
function tappedSeed(small, edges, hint) {
  const w = small.width, h = small.height, px = small.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (edges[i]) continue;
    const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 100 && (mx - mn) / mx < 0.22) mask[i] = 1;
  }
  const reach = 0.3 * Math.max(w, h);
  const near = [];
  for (const blob of regions(mask, w, h, Math.max(50, Math.floor(w * h / 4000)))) {
    let cx = 0, cy = 0;
    for (const i of blob) { cx += i % w; cy += (i / w) | 0; }
    const d = Math.hypot(cx / blob.length - hint.x, cy / blob.length - hint.y);
    if (d < reach) near.push({ d, blob });
  }
  near.sort((a, b) => a.d - b.d);
  let best = null;
  const union = new Uint8Array(w * h);
  const pts = [];
  for (const { blob } of near.slice(0, 8)) {
    for (const i of blob) { union[i] = 1; pts.push({ x: (i % w) + 0.5, y: ((i / w) | 0) + 0.5 }); }
    const rect = minAreaRect(pts);
    if (!rect) continue;
    const a = len(sub(rect[1], rect[0])), b = len(sub(rect[3], rect[0]));
    if (Math.min(a, b) <= 8 || !contains(rect, hint)) continue;
    const aspect = Math.max(a, b) / Math.min(a, b);
    const rim = rimCoverage(union, w, h, rect);
    if (aspect <= 1.1 || aspect >= 1.8 || rim <= 0.7) continue;
    const score = rim * Math.exp(-Math.pow((aspect - 1.4) / 0.2, 2));
    if (!best || score > best.score) best = { score, quad: rect };
  }
  debugLog('tapped seed', best && best.quad.map((p) => `[${Math.round(p.x)},${Math.round(p.y)}]`).join(' '));
  return best ? best.quad : null;
}

/** 四角の縁（内側2〜8%）に沿って印のある画素が続いている割合 */
function rimCoverage(mask, w, h, q) {
  let hit = 0, total = 0;
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < 24; k++) {
      const t = (k + 0.5) / 24;
      total++;
      for (let d = 0.02; d <= 0.0801; d += 0.01) {
        const pt = side === 0 ? quadPoint(q, t, d) : side === 1 ? quadPoint(q, 1 - d, t)
          : side === 2 ? quadPoint(q, t, 1 - d) : quadPoint(q, d, t);
        const x = Math.floor(pt.x), y = Math.floor(pt.y);
        if (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) { hit++; break; }
      }
    }
  }
  return hit / total;
}

/** 候補の中心から「紙らしい画素」を境目を越えずに塗り広げ、その輪郭に4本の直線を当てはめる */
function regionQuad(q, small, edges, paper) {
  const w = small.width, h = small.height, px = small.data;
  const isPaper = (i) => {
    if (edges[i]) return false;
    const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    return mx > 90 && (mx - mn) / mx < 0.22 && l > 0.7 * paper && l < 1.3 * paper;
  };
  const seedArea = Math.abs(cross(sub(q[1], q[0]), sub(q[3], q[0])));
  const region = new Uint8Array(w * h);
  const stack = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const p = quadPoint(q, 0.35 + 0.3 * i / 4, 0.35 + 0.3 * j / 4);
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = y * w + x;
      if (region[k] || !isPaper(k)) continue;
      region[k] = 1;
      stack.push(k);
    }
  }
  // 絵札は中央が絵なので、中央から塗り広げられない。そのときは縁の帯（端から6%内側）からも始める
  if (stack.length < 3) {
    for (let k = 0; k < 16; k++) {
      const t = 0.15 + 0.7 * k / 15;
      for (const [u, v] of [[t, 0.06], [t, 0.94], [0.06, t], [0.94, t]]) {
        const p = quadPoint(q, u, v);
        const x = Math.floor(p.x), y = Math.floor(p.y);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (region[i] || !isPaper(i)) continue;
        region[i] = 1;
        stack.push(i);
      }
    }
  }
  let area = 0;
  while (stack.length) {
    const i = stack.pop();
    area++;
    if (area > 4 * seedArea) return null;   // 境目が切れていて背景まで漏れ出した
    const x = i % w, y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !region[j] && isPaper(j)) { region[j] = 1; stack.push(j); }
  }
  if (area <= 200) return null;
  // 印刷されたカードのマークやインデックスの穴は埋めてから形を見る（理由は Swift 側）
  area += fillEnclosedHoles(region, w, h);

  const boundary = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!region[i]) continue;
      if (!region[i - 1] || !region[i + 1] || !region[i - w] || !region[i + w]) boundary.push({ x: x + 0.5, y: y + 0.5 });
    }
  }
  const rect = minAreaRect(boundary);
  if (!rect) return null;

  // 外接長方形の各辺の近くにある輪郭点を、その辺の点として直線を当てはめる。角の近くは使わない
  const short = Math.min(len(sub(rect[1], rect[0])), len(sub(rect[3], rect[0])));
  const fitSides = (reach) => {
    const lines = [];
    for (let side = 0; side < 4; side++) {
      const a = rect[side], b = rect[(side + 1) % 4];
      const L = len(sub(b, a));
      const d = mul(sub(b, a), 1 / L);
      const sideLine = { p: a, d };
      const pts = boundary.filter((p) => {
        const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / L;
        return t > 0.12 && t < 0.88 && lineDistance(sideLine, p) < reach * short;
      });
      const l = robustFit(pts);
      if (!l) return null;
      lines.push(l);
    }
    const corners = [];
    for (let i = 0; i < 4; i++) {
      const p = lineIntersection(lines[(i + 3) % 4], lines[i]);
      if (!p) return null;
      corners.push(p);
    }
    return isReasonableQuad(corners) ? corners : null;
  };
  // 形が崩れたときだけ範囲を広げてやり直す（理由は Swift 側）
  const corners = fitSides(0.15) || fitSides(0.3);
  if (!corners) return null;
  const quadArea = 0.5 * Math.abs(cross(sub(corners[2], corners[0]), sub(corners[3], corners[1])));
  return { quad: corners, area, fill: area / Math.max(quadArea, 1) };
}

/** カードを写した形としてありうる四角形か：凸で、どの角も 50°〜130° */
function isReasonableQuad(p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = sub(p[(i + 3) % 4], p[i]), b = sub(p[(i + 1) % 4], p[i]);
    const c = cross(b, a);
    if (sign === 0) sign = c; else if (c * sign <= 0) return false;
    const cos = (a.x * b.x + a.y * b.y) / Math.max(len(a) * len(b), 1e-6);
    if (Math.abs(cos) > Math.cos(50 * Math.PI / 180)) return false;
  }
  return true;
}

/** 各辺に沿って何十か所で「紙から外へ出て暗くなる境目」を探し、外れ値を除いて直線を当てはめ直す */
function refine(q, lum, w, h, paper) {
  const sample = (p) => {
    const x = Math.min(Math.max(p.x, 0), w - 2), y = Math.min(Math.max(p.y, 0), h - 2);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    return (lum[i] * (1 - fx) + lum[i + 1] * fx) * (1 - fy) + (lum[i + w] * (1 - fx) + lum[i + w + 1] * fx) * fy;
  };
  const width = len(sub(q[1], q[0])), height = len(sub(q[3], q[0]));
  const threshold = Math.max(8, 0.06 * paper);
  const lines = [];
  for (let side = 0; side < 4; side++) {
    const a = q[side], b = q[(side + 1) % 4];
    const d = mul(sub(b, a), 1 / len(sub(b, a)));
    const n = { x: d.y, y: -d.x };   // 外向き（四隅は時計回り）
    const perp = side % 2 === 0 ? height : width;
    const sMin = -0.04 * perp, sMax = 0.04 * perp;
    const found = [];
    for (let k = 0; k < 60; k++) {
      const p = add(a, mul(sub(b, a), 0.15 + 0.7 * k / 59));
      for (let s = sMin; s < sMax; s += 0.5) {
        const drop = sample(add(p, mul(n, s - 1.5))) - sample(add(p, mul(n, s + 1.5)));
        const inside = sample(add(p, mul(n, s - 3)));
        if (drop > threshold && inside > 0.75 * paper && inside < 1.25 * paper) {
          let peak = s, peakDrop = drop;
          for (let t = s + 0.5; t < sMax; t += 0.5) {
            const dt = sample(add(p, mul(n, t - 1.5))) - sample(add(p, mul(n, t + 1.5)));
            if (dt < peakDrop) break;
            peak = t; peakDrop = dt;
          }
          found.push(add(p, mul(n, peak)));
          break;
        }
      }
    }
    if (found.length < 15) return null;
    const l = robustFit(found);
    if (!l) return null;
    lines.push(l);
  }
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const p = lineIntersection(lines[(i + 3) % 4], lines[i]);
    if (!p) return null;
    corners.push(p);
  }
  return corners;
}

// MARK: - 印刷を消す（絵札以外のカード）

/**
 * 印刷されたカード（絵札以外）なら、指を残してインクだけを消して白紙にする（photo をその場で書き換える）。
 * インクが見つからなければ（白紙なら）何もせず false。Swift の CardEraser.swift を移したもの（理由はそちら）
 */
// MARK: - カードを当てる（Swift の CardMatcher と同じ）

export const MATCH_W = CARD_W / 2, MATCH_H = CARD_H / 2;

/** tools/make_card_index.py が作る索引（cards/index.bin）を読む */
export function parseCardIndex(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length < 10 || String.fromCharCode(...b.slice(0, 4)) !== 'MPCI') return null;
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  const w = u16(4), h = u16(6), count = u16(8);
  const cards = [];
  let o = 10;
  for (let k = 0; k < count; k++) {
    if (o + 4 + w * h > b.length) return null;
    const name = String.fromCharCode(...b.slice(o, o + 4).filter((c) => c));
    const ink = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ink[i] = b[o + 4 + i] / 255;
    cards.push({ name, ink });
    o += 4 + w * h;
  }
  return { w, h, cards };
}

function nccArrays(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.max(Math.sqrt(saa * sbb), 1e-9);
}

/** 窓 [x0, y0, x1, y1) の中で、写真 obs と「dx, dy ずらした素材 t」の相関。step で間引く */
function shiftedNCC(obs, t, w, h, dx, dy, win, step) {
  let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, n = 0;
  for (let y = win[1]; y < win[3]; y += step) {
    const ty = y - dy;
    for (let x = win[0]; x < win[2]; x += step) {
      const tx = x - dx;
      const a = obs[y * w + x];
      const b = tx >= 0 && ty >= 0 && tx < w && ty < h ? t[ty * w + tx] : 0;
      sa += a; sb += b; sab += a * b; saa += a * a; sbb += b * b; n++;
    }
  }
  if (!n) return -1;
  const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  return cov / Math.max(Math.sqrt(va * vb), 1e-9);
}

/** 写真のカードを正面向き（w×h）に直したインクの濃さ（0=紙 1=黒） */
function rectifiedInk(quad, photo, w, h) {
  const W = photo.width, d = photo.data;
  const toPhoto = homography([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], quad);
  if (!toPhoto) return null;
  const lumAt = (x, y) => {
    const k = 4 * (y * W + x);
    return 0.2126 * FROM8[d[k]] + 0.7152 * FROM8[d[k + 1]] + 0.0722 * FROM8[d[k + 2]];
  };
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = toPhoto(x + 0.5, y + 0.5);
      const fx = u - 0.5, fy = v - 0.5;
      const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(photo.height - 2, Math.floor(fy)));
      const ax = Math.max(0, Math.min(1, fx - ix)), ay = Math.max(0, Math.min(1, fy - iy));
      lum[y * w + x] = (lumAt(ix, iy) * (1 - ax) + lumAt(ix + 1, iy) * ax) * (1 - ay)
        + (lumAt(ix, iy + 1) * (1 - ax) + lumAt(ix + 1, iy + 1) * ax) * ay;
    }
  }
  const pq = shrink(lum, w, h, 4, true);   // 紙の明るさはなめらかなので 1/4 の大きさで求める
  maxFilter(pq.d, pq.dw, pq.dh, 5);
  gaussianBlur(pq.d, pq.dw, pq.dh, 3);
  const paper = expand(pq, 4, w, h);
  const obs = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) obs[i] = Math.max(0, Math.min(1, 1 - lum[i] / Math.max(paper[i], 1e-4)));
  return obs;
}

/** どのカードかを当てる。当てられなければ null（理由と基準は Swift 側） */
export function identifyCard(quad, photo, index) {
  if (!index) return null;
  const obs = rectifiedInk(quad, photo, MATCH_W, MATCH_H);
  if (!obs) return null;
  const f = MATCH_W / index.w;
  const small = new Float32Array(index.w * index.h);
  for (let y = 0; y < index.h; y++) {
    for (let x = 0; x < index.w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += obs[(y * f + dy) * MATCH_W + x * f + dx];
      small[y * index.w + x] = s / (f * f);
    }
  }
  let best = null;
  for (const card of index.cards) {
    for (const rotated of [false, true]) {
      const t = rotated ? card.ink.slice().reverse() : card.ink;
      const score = nccArrays(small, t);
      if (!best || score > best.score) best = { score, name: card.name, rotated };
    }
  }
  debugLog('match', best && best.name, best && best.rotated ? '180' : '', 'score', best && best.score);
  if (!best || best.score <= 0.45) return null;
  return { ...best, obs };
}

/** 当てたカードの素材（makeCardFace の結果）を、写真のマークと数字にぴったり合わせた場所（MATCH_W×MATCH_H、1=インク） */
export function alignMarks(found, face) {
  const MW = MATCH_W, MH = MATCH_H, obs = found.obs;
  let tmpl = new Float32Array(MW * MH);
  for (let y = 0; y < MH; y++) {
    for (let x = 0; x < MW; x++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = (2 * y + dy) * CARD_W + 2 * x + dx;
          s += 1 - (0.2126 * face.r[i] + 0.7152 * face.g[i] + 0.0722 * face.b[i]);
        }
      }
      tmpl[y * MW + x] = s / 4;
    }
  }
  if (found.rotated) tmpl = tmpl.reverse();
  // カード全体のずれ（±16）
  const whole = [0, 0, MW, MH];
  let g = { score: -Infinity, dx: 0, dy: 0 };
  for (let dy = -16; dy <= 16; dy += 2) {
    for (let dx = -16; dx <= 16; dx += 2) {
      const s = shiftedNCC(obs, tmpl, MW, MH, dx, dy, whole, 3);
      if (s > g.score) g = { score: s, dx, dy };
    }
  }
  const g0 = { ...g };
  for (let dy = g0.dy - 1; dy <= g0.dy + 1; dy++) {
    for (let dx = g0.dx - 1; dx <= g0.dx + 1; dx++) {
      if (dx === g0.dx && dy === g0.dy) continue;
      const s = shiftedNCC(obs, tmpl, MW, MH, dx, dy, whole, 3);
      if (s > g.score) g = { score: s, dx, dy };
    }
  }
  // マークと数字を1つずつ（±8）。指で隠れて合わないものは全体のずれのまま
  const mask = new Uint8Array(MW * MH);
  for (let i = 0; i < MW * MH; i++) if (tmpl[i] > 0.25) mask[i] = 1;
  const expected = new Uint8Array(MW * MH);
  const shifts = [];
  for (const comp of regions(mask, MW, MH, 8)) {
    let x0 = MW, y0 = MH, x1 = 0, y1 = 0;
    for (const i of comp) {
      const x = i % MW, y = (i / MW) | 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const m = 12;
    const win = [Math.max(0, x0 + g.dx - m), Math.max(0, y0 + g.dy - m), Math.min(MW, x1 + 1 + g.dx + m), Math.min(MH, y1 + 1 + g.dy + m)];
    const part = new Float32Array(MW * MH);
    for (const i of comp) part[i] = tmpl[i];
    let c = { score: -Infinity, dx: g.dx, dy: g.dy };
    for (let dy = g.dy - 8; dy <= g.dy + 8; dy++) {
      for (let dx = g.dx - 8; dx <= g.dx + 8; dx++) {
        const s = shiftedNCC(obs, part, MW, MH, dx, dy, win, 1);
        if (s > c.score) c = { score: s, dx, dy };
      }
    }
    if (c.score < 0.5) c = { score: c.score, dx: g.dx, dy: g.dy };
    shifts.push(`${c.dx - g.dx},${c.dy - g.dy}`);
    for (const i of comp) {
      const x = (i % MW) + c.dx, y = ((i / MW) | 0) + c.dy;
      if (x >= 0 && y >= 0 && x < MW && y < MH) expected[y * MW + x] = 1;
    }
  }
  debugLog('align global', g.dx * 2, g.dy * 2, 'parts', shifts.join(' '));
  return expected;
}

/**
 * 印刷を消す。expectedHalf は、当てたカードのマークと数字のある場所（カードの座標の半分の大きさ、alignMarks の結果）。
 * なければ色だけで見分ける
 */
export function eraseInk(quad, photo, expectedHalf = null) {
  const W = photo.width, H = photo.height;
  const cardW = len(sub(quad[1], quad[0]));
  const margin = cardW * 0.05;
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - margin)), y0 = Math.max(0, Math.floor(Math.min(...ys) - margin));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs) + margin)), y1 = Math.min(H, Math.ceil(Math.max(...ys) + margin));
  const cw = x1 - x0, ch = y1 - y0;
  if (cw <= 10 || ch <= 10) return false;
  const n = cw * ch, d = photo.data;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), lum = new Float32Array(n);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x, k = 4 * ((y0 + y) * W + x0 + x);
      R[i] = FROM8[d[k]]; G[i] = FROM8[d[k + 1]]; B[i] = FROM8[d[k + 2]];
      lum[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    }
  }

  // カードの内側：角丸の形。縁のきわは少し内側まで
  const local = quad.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
  const toCard = homography(local, [{ x: 0, y: 0 }, { x: CARD_W, y: 0 }, { x: CARD_W, y: CARD_H }, { x: 0, y: CARD_H }]);
  if (!toCard) return false;
  const corner = 0.06 * CARD_W;
  const inside = new Uint8Array(n);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const [u, v] = toCard(x + 0.5, y + 0.5);
      if (!(u >= 0 && v >= 0 && u < CARD_W && v < CARD_H)) continue;
      const du = Math.max(corner - u, u - (CARD_W - corner), 0), dv = Math.max(corner - v, v - (CARD_H - corner), 0);
      if (du * du + dv * dv <= corner * corner) inside[y * cw + x] = 1;
    }
  }
  erode(inside, cw, ch, Math.max(2, Math.floor(cardW * 0.006)));
  let insideCount = 0;
  for (let i = 0; i < n; i++) if (inside[i]) insideCount++;
  if (insideCount <= 1000) return false;

  // 下調べ：はっきりしたインクがほとんどなければ白紙（重い計算をしないで済ませる）
  const sample = [];
  for (let i = 0; i < n; i += 7) if (inside[i]) sample.push(lum[i]);
  sample.sort((a, b) => a - b);
  const brightPaper = sample[Math.floor(sample.length * 9 / 10)];
  let obvious = 0;
  for (let i = 0; i < n; i += 2) {
    if (!inside[i]) continue;
    const s0 = R[i] + G[i] + B[i] + 1e-6;
    if ((R[i] - Math.max(G[i], B[i])) / s0 > 0.55 || lum[i] < 0.25 * brightPaper) obvious++;
  }
  if (obvious * 2 <= insideCount / 400) return false;

  // マークの場所（写真の画素ごと）と、そのまわり（カード幅の5%。理由は Swift 側）
  let expected = null, nearMarks = null;
  if (expectedHalf) {
    expected = new Uint8Array(n);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        if (!inside[i]) continue;
        const [u, v] = toCard(x + 0.5, y + 0.5);
        const mx = Math.min(MATCH_W - 1, Math.max(0, Math.floor(u / 2))), my = Math.min(MATCH_H - 1, Math.max(0, Math.floor(v / 2)));
        if (expectedHalf[my * MATCH_W + mx]) expected[i] = 1;
      }
    }
    nearMarks = expected.slice();
    dilate(nearMarks, cw, ch, Math.max(6, Math.floor(cardW * 0.05)));
  }

  // 紙の明るさの目安（局所的な最大値をならす）と紙の色
  // （なめらかな量なので 1/4 の大きさで求める）
  const k = Math.max(7, Math.floor(cardW / 50));
  const peFull = new Float32Array(n);
  for (let i = 0; i < n; i++) if (inside[i]) peFull[i] = lum[i];
  const pe = shrink(peFull, cw, ch, 4, true);
  maxFilter(pe.d, pe.dw, pe.dh, Math.max(2, Math.round(k / 4)));
  gaussianBlur(pe.d, pe.dw, pe.dh, k / 4);
  const paperEst = expand(pe, 4, cw, ch);
  const insideLum = [];
  for (let i = 0; i < n; i += 11) if (inside[i]) insideLum.push(lum[i]);   // 間引いて並べる（全部並べると遅い）
  insideLum.sort((a, b) => a - b);
  const lumCut = insideLum[Math.floor(insideLum.length * 2 / 5)];
  const pr = [], pg = [], pb = [];
  for (let i = 0; i < n; i += 3) if (inside[i] && lum[i] > lumCut) { pr.push(R[i]); pg.push(G[i]); pb.push(B[i]); }
  const median = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const paper = [median(pr), median(pg), median(pb)];
  const ps = paper[0] + paper[1] + paper[2];
  const pc = paper.map((v) => v / ps);
  const Rs = R.slice(), Gs = G.slice(), Bs = B.slice();
  gaussianBlur(Rs, cw, ch, 1.5); gaussianBlur(Gs, cw, ch, 1.5); gaussianBlur(Bs, cw, ch, 1.5);

  // 絵札：真ん中がほとんど紙でなければ絵札とみなし、紙の色でも手でもないものを消す（理由は Swift 側）
  const paperLike = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    const s = Rs[i] + Gs[i] + Bs[i] + 1e-6;
    const dr = Rs[i] / s - pc[0], dg = Gs[i] / s - pc[1], db = Bs[i] / s - pc[2];
    if (lum[i] > 0.55 * paperEst[i] && Math.sqrt(dr * dr + dg * dg + db * db) < 0.07) paperLike[i] = 1;
  }
  // 手の形を求めるのは重いので、まず手を除かずに数える。手を除くと「紙でないもの」の割合は下がるだけなので、
  // この時点で6割以下なら数字札と決まり、手の形は要らない
  const centerArtRatio = (hand) => {
    let center = 0, centerArt = 0;
    for (let y = 0; y < ch; y += 2) {
      for (let x = 0; x < cw; x += 2) {
        const i = y * cw + x;
        if (!inside[i] || (hand && hand[i])) continue;
        const [u, v] = toCard(x + 0.5, y + 0.5);
        if (u <= 0.3 * CARD_W || u >= 0.7 * CARD_W || v <= 0.3 * CARD_H || v >= 0.7 * CARD_H) continue;
        center++;
        if (!paperLike[i]) centerArt++;
      }
    }
    debugLog('court?', 'center art', centerArt, 'of', center);
    return center > 125 ? centerArt / center : 0;
  };
  let hand = null, isCourt = false;
  if (centerArtRatio(null) > 0.6) {
    hand = handReachingIn(Rs, Gs, Bs, inside, paperLike, pc, cw, ch, cardW);
    isCourt = centerArtRatio(hand) > 0.6;
  }
  debugLog('court?', isCourt);

  let erase, skin, band;
  if (isCourt) {
    skin = hand;
    const art = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (inside[i] && !paperLike[i] && !hand[i]) art[i] = 1;
    // 消すのは絵の枠（いちばん大きな塊）と、隅の数字とマーク（赤か黒のインク）だけ
    erase = new Uint8Array(n);
    const blobs = regions(art, cw, ch, 20);
    const largest = blobs.reduce((m, b) => Math.max(m, b.length), 0);
    for (const blob of blobs) {
      let inky = 0;
      for (const i of blob) {
        const s = Rs[i] + Gs[i] + Bs[i] + 1e-6;
        if ((Rs[i] - Math.max(Gs[i], Bs[i])) / s > 0.45 || lum[i] < 0.35 * paperEst[i]) inky++;
      }
      if (blob.length === largest || inky * 3 > blob.length) for (const i of blob) erase[i] = 1;
    }
    const r = Math.max(3, Math.floor(cardW * 0.01));
    dilate(erase, cw, ch, r);
    erode(erase, cw, ch, r);
    fillEnclosedHoles(erase, cw, ch);
    dilate(erase, cw, ch, Math.max(3, Math.floor(cardW * 0.008)));
    for (let i = 0; i < n; i++) if (skin[i] || !inside[i]) erase[i] = 0;
    // カードを当てられたときは、素材の「絵の枠と隅の数字」のまわり（3%）の外は消さない（理由は Swift 側）
    if (expected) {
      const region = expected.slice();
      fillEnclosedHoles(region, cw, ch);
      dilate(region, cw, ch, Math.max(4, Math.floor(cardW * 0.03)));
      for (let i = 0; i < n; i++) if (!region[i]) erase[i] = 0;
    }
    band = erase.slice();
    dilate(band, cw, ch, Math.max(4, Math.floor(cardW * 0.01)));
  } else {
    // インク：鮮やかな赤（指は赤さ0.32〜0.40、インクは0.7〜0.9）か黒。肌は紙の色から外れて黄みがある
    let core = new Uint8Array(n);
    const weak = new Uint8Array(n);
    const skinColor = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const s = Rs[i] + Gs[i] + Bs[i] + 1e-6;
      const r = Rs[i] / s, g = Gs[i] / s, b = Bs[i] / s;
      const redness = r - Math.max(g, b);
      const isInk = redness > 0.45 || lum[i] < 0.35 * paperEst[i];
      if (isInk && inside[i]) core[i] = 1;
      // 反射で灰色に写った黒いマーク：はっきりしたインクにつながっているときだけ加える（理由は Swift 側）
      if (!isInk && inside[i] && lum[i] < 0.6 * paperEst[i] && redness < 0.03) weak[i] = 1;
      const dr = r - pc[0], dg = g - pc[1], db = b - pc[2];
      // 肌はカードの内側だけで見る（背景が肌に近い色だと、カード全体が「手の中の穴」として埋まった。理由は Swift 側）
      if (!isInk && inside[i] && Math.sqrt(dr * dr + dg * dg + db * db) > 0.06 && g - b > 0.03) skinColor[i] = 1;
    }
    erode(core, cw, ch, 1);
    dilate(core, cw, ch, 1);
    const both = core.slice();
    for (let i = 0; i < n; i++) if (weak[i]) both[i] = 1;
    // 灰色に写るのは黒いマークだけ。赤いマークにつながる灰色は指の影のことがあった（理由は Swift 側、IMG_7018）
    for (const blob of regions(both, cw, ch, 1)) {
      if (blob.some((i) => core[i] && lum[i] < 0.35 * paperEst[i])) for (const i of blob) core[i] = 1;
    }
    // マークの内側が反射で明るくなった「穴」も埋めて、マークごと消す
    fillEnclosedHoles(core, cw, ch);
    for (let i = 0; i < n; i++) if (!inside[i]) core[i] = 0;

    // 肌は大きな塊だけ。すき間と穴を埋めて「手の形」にし、その中は塗らない
    skin = keepLargeRegions(skinColor, cw, ch, Math.floor(insideCount / 200));
    const rr = Math.max(5, Math.floor(cardW * 0.03));
    dilate(skin, cw, ch, rr);
    erode(skin, cw, ch, rr);
    fillEnclosedHoles(skin, cw, ch);
    dilate(skin, cw, ch, 1);

    // 手に接している塊は、鮮やかな赤か、赤みのない黒のときだけインクとする
    const handEdge = skin.slice();
    dilate(handEdge, cw, ch, 2);
    const outsideHand = core.slice();
    for (let i = 0; i < n; i++) if (skin[i]) outsideHand[i] = 0;
    core = new Uint8Array(n);
    for (const blob of regions(outsideHand, cw, ch, 1)) {
      let touches = false, sr = 0, sg = 0, sb = 0, sd = 0;
      for (const i of blob) {
        if (handEdge[i]) touches = true;
        sd += lum[i] / Math.max(paperEst[i], 1e-4);
        const s = Rs[i] + Gs[i] + Bs[i] + 1e-6;
        sr += Rs[i] / s; sg += Gs[i] / s; sb += Bs[i] / s;
      }
      const redness = (sr - Math.max(sg, sb)) / blob.length;
      // 黒いマークは紙の5%ほどの暗さ。指とカードの境目の影の筋は30%ほど（理由は Swift 側、IMG_7018）
      if (!touches || redness > 0.55 || (redness < 0.2 && sd / blob.length < 0.2)) for (const i of blob) core[i] = 1;
    }

    // カードを当てられたとき：インクは「素材のマークの場所」と「その近くで色がインクらしいところ」（理由は Swift 側）
    if (expected) {
      const exp = expected.slice();
      dilate(exp, cw, ch, Math.max(2, Math.floor(cardW * 0.006)));
      for (let i = 0; i < n; i++) core[i] = (core[i] && nearMarks[i]) || (exp[i] && !skin[i]) ? 1 : 0;
    }

    // インクがほとんどない（白紙のカード）なら何もしない
    let inkCount = 0;
    for (let i = 0; i < n; i++) if (core[i]) inkCount++;
    debugLog('ink pixels', inkCount, 'of', insideCount);
    if (inkCount <= insideCount / 200) return false;

    // マークよりひと回り大きく消す。手の形の中は塗らないが、はっきり赤いインクの色の画素は消す
    const grow = Math.max(6, Math.floor(cardW * 0.02));
    erase = core.slice();
    dilate(erase, cw, ch, grow);
    for (let i = 0; i < n; i++) if (skin[i] || !inside[i]) erase[i] = 0;
    const strongRed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!inside[i]) continue;
      const s = Rs[i] + Gs[i] + Bs[i] + 1e-6;
      if ((Rs[i] - Math.max(Gs[i], Bs[i])) / s > 0.55) strongRed[i] = 1;
    }
    dilate(strongRed, cw, ch, Math.max(2, Math.floor(grow / 4)));
    for (let i = 0; i < n; i++) if (strongRed[i] && inside[i] && !skinColor[i] && (!nearMarks || nearMarks[i])) erase[i] = 1;
    band = core.slice();
    dilate(band, cw, ch, 2 * grow);

  }

  // 照明：消す範囲だけを除いたすぐ近くの紙から、なだらかに推測する。穴が大きいところは広く見る
  const nearClean = new Float32Array(n);
  // 絵札では、消さなかったところにも絵のふちが残っているので、紙の色の画素だけから推測する
  for (let i = 0; i < n; i++) if (inside[i] && !erase[i] && !skin[i] && (!isCourt || paperLike[i])) nearClean[i] = 1;
  // （なめらかな量なので 1/4 の大きさで求める。数字札はこのあと穴の縁でぴったり合わせ直す）
  const F = 4;
  const wq = shrink(nearClean, cw, ch, F, false);
  const tmp = new Float32Array(n);
  const mq = [R, G, B].map((c) => { for (let i = 0; i < n; i++) tmp[i] = c[i] * nearClean[i]; return shrink(tmp, cw, ch, F, false); });
  const eq = shrink(Float32Array.from(erase), cw, ch, F, true);
  const qn = wq.dw * wq.dh;
  const lowFill = [new Float32Array(qn), new Float32Array(qn), new Float32Array(qn)], lowFilled = new Float32Array(qn);
  for (const sigma of [cardW / 40, cardW / 15, cardW / 6, cardW / 2]) {
    const ws = wq.d.slice();
    gaussianBlur(ws, wq.dw, wq.dh, sigma / F);
    const ms = mq.map((q) => { const a = q.d.slice(); gaussianBlur(a, wq.dw, wq.dh, sigma / F); return a; });
    let missing = false;
    for (let j = 0; j < qn; j++) {
      if (lowFilled[j]) continue;
      if (ws[j] > 0.15) { for (let c = 0; c < 3; c++) lowFill[c][j] = ms[c][j] / ws[j]; lowFilled[j] = 1; }
      else if (eq.d[j] > 0) missing = true;
    }
    if (!missing) break;
  }
  // 使うのは消す画素と、そのまわり（穴の縁を合わせ直すときの出発点）だけ
  const need = erase.slice();
  dilate(need, cw, ch, 2);
  // 元の大きさに戻すときは、紙の色が入ったマスだけで混ぜる。カードの外にかかるマスは色が入らず0のままで、
  // そのまま混ぜるとカードの縁に近い消した跡が黒くなった（数字が縁ぎりぎりにあった写真。IMG_7113・7114、2026-10-14）。
  // どのマスにも色がないところは、紙の色と明るさの目安で埋める
  const fillR = new Float32Array(n), fillG = new Float32Array(n), fillB = new Float32Array(n);
  const filled = new Uint8Array(n);
  const expandFill = (only) => {
    const wgt = expand({ d: lowFilled, dw: wq.dw, dh: wq.dh }, F, cw, ch, only);
    const full = lowFill.map((d) => expand({ d, dw: wq.dw, dh: wq.dh }, F, cw, ch, only));
    const dst = [fillR, fillG, fillB];
    for (let i = 0; i < n; i++) {
      if (!only[i]) continue;
      if (wgt[i] > 1e-3) {
        for (let c = 0; c < 3; c++) dst[c][i] = full[c][i] / wgt[i];
      } else {
        const l = paperEst[i] > 0 ? paperEst[i] : brightPaper;
        for (let c = 0; c < 3; c++) dst[c][i] = pc[c] * 3 * l;
      }
      filled[i] = 1;
    }
  };
  expandFill(need);
  // 絵札は消す範囲が広いので、縁の紙の色と明るさに、カード全体でなめらかな面（2次式）を当てはめて埋める
  if (isCourt) {
    const samples = [];
    for (let i = 0; i < n; i += 5) if (nearClean[i]) samples.push([(i % cw) / cw, ((i / cw) | 0) / ch, R[i], G[i], B[i]]);
    const cr = samples.length > 50 && fitQuadratic(samples, 2);
    const cg = cr && fitQuadratic(samples, 3);
    const cb = cg && fitQuadratic(samples, 4);
    if (cb) {
      const at = (c, x, y) => Math.max(0, c[0] + c[1] * x + c[2] * y + c[3] * x * x + c[4] * x * y + c[5] * y * y);
      for (let i = 0; i < n; i++) {
        if (!erase[i]) continue;
        const x = (i % cw) / cw, y = ((i / cw) | 0) / ch;
        fillR[i] = at(cr, x, y); fillG[i] = at(cg, x, y); fillB[i] = at(cb, x, y);
        filled[i] = 1;
      }
    }
  }
  // 数字札：穴の縁の色をなめらかにつなぐ（ラプラス方程式を SOR 法で。絵札には使わない。理由は Swift 側）
  if (!isCourt) {
    const boundary = new Uint8Array(n);   // 1 = 縁の値として使う紙、2 = 解く穴
    for (let i = 0; i < n; i++) {
      if (!inside[i] || skin[i]) continue;
      // 位置が分かっているときは、暗い画素を穴に含めるのもマークの近くだけ
      boundary[i] = erase[i] || (lum[i] < 0.6 * paperEst[i] && (!nearMarks || nearMarks[i])) ? 2 : 1;
    }
    const island = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (boundary[i] === 1) island[i] = 1;
    for (const blob of regions(island, cw, ch, 1)) if (blob.length < insideCount / 100) for (const i of blob) boundary[i] = 2;
    // 解くのは穴の縁から十数ピクセルの帯だけ。奥はなめらかな推定のままで、帯の内側の端がそれにつながる
    // （大きなマークの穴を全部解くと遅かった。縁を合わせる効果は帯の中で足りる）
    const nearEdge = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (boundary[i] === 1) nearEdge[i] = 1;
    dilate(nearEdge, cw, ch, 14);
    const holes = [];
    for (let i = 0; i < n; i++) {
      if (boundary[i] !== 2) continue;
      erase[i] = 1;
      if (nearEdge[i]) holes.push(i); else boundary[i] = 3;   // 3 = 奥（推定の値のまま、帯の縁として使う）
    }
    const nbStart = new Int32Array(holes.length + 1), nbIndex = [];
    holes.forEach((i, k) => {
      const x = i % cw;
      for (const j of [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, i >= cw ? i - cw : -1, i + cw < n ? i + cw : -1]) {
        if (j >= 0 && boundary[j]) nbIndex.push(j);
      }
      nbStart[k + 1] = nbIndex.length;
    });
    const nb = Int32Array.from(nbIndex);
    for (let i = 0; i < n; i++) if (boundary[i] === 1) { fillR[i] = Rs[i]; fillG[i] = Gs[i]; fillB[i] = Bs[i]; }
    // 消す範囲の外から穴に加えた画素（マークの近くの暗い画素・取り残された島）は、まだ出発点が入っていないので入れる
    const mark = new Uint8Array(n);
    let marked = 0;
    for (let i = 0; i < n; i++) if (boundary[i] >= 2 && !need[i]) { mark[i] = 1; marked++; }
    if (marked) expandFill(mark);
    for (let it = 0; it < 30; it++) {
      for (let k = 0; k < holes.length; k++) {
        const s0 = nbStart[k], s1 = nbStart[k + 1];
        if (s1 <= s0) continue;
        let sr = 0, sg = 0, sb = 0;
        for (let t = s0; t < s1; t++) { const j = nb[t]; sr += fillR[j]; sg += fillG[j]; sb += fillB[j]; }
        const i = holes[k], inv = 1 / (s1 - s0);
        fillR[i] += 1.9 * (sr * inv - fillR[i]);
        fillG[i] += 1.9 * (sg * inv - fillG[i]);
        fillB[i] += 1.9 * (sb * inv - fillB[i]);
      }
    }
    for (let i = 0; i < n; i++) if (boundary[i] >= 2) filled[i] = 1;
  }
  // それでも近くに紙が見つからないところは、紙の色と明るさの目安で埋める
  for (let i = 0; i < n; i++) {
    if (filled[i]) continue;
    const l = paperEst[i] > 0 ? paperEst[i] : brightPaper;
    fillR[i] = pc[0] * 3 * l; fillG[i] = pc[1] * 3 * l; fillB[i] = pc[2] * 3 * l;
  }

  // 布目：きれいな紙の「明るさ ÷ 照明」の揺れを、少しずらした位置から写す
  // 揺れは「すぐ近くの紙の平均」との比で取る（細かい凹凸だけ。理由は Swift 側）
  const resid = new Float32Array(n), cleanTex = new Uint8Array(n);
  const texMask = new Float32Array(n), localLum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!inside[i] || band[i] || skin[i] || (isCourt && !paperLike[i])) continue;
    cleanTex[i] = 1; texMask[i] = 1; localLum[i] = lum[i];
  }
  const texSigma = Math.max(2, cardW / 200);
  gaussianBlur(localLum, cw, ch, texSigma);
  gaussianBlur(texMask, cw, ch, texSigma);
  for (let i = 0; i < n; i++) {
    if (cleanTex[i]) resid[i] = lum[i] / Math.max(localLum[i] / Math.max(texMask[i], 1e-4), 1e-4) - 1;
  }
  const tex = new Float32Array(n), got = new Uint8Array(n);
  const step = Math.floor(cardW * 0.13);
  const shifts = [];
  for (let k2 = 1; k2 <= 5; k2++) { const st = k2 * step; shifts.push([st, 0], [-st, 0], [0, st], [0, -st], [st, st], [-st, -st]); }
  // 消す画素ごとに、ずらし方を順に試して最初に見つかった元を使う（全体を何十回もなめるより速い）
  if (!isCourt) {
    for (let i = 0; i < n; i++) {
      if (!erase[i]) continue;
      const x = i % cw, y = (i / cw) | 0;
      for (const [dx, dy] of shifts) {
        const sx = x - dx, sy = y - dy;
        if (sx < 0 || sx >= cw || sy < 0 || sy >= ch) continue;
        const j = sy * cw + sx;
        // 布目の揺れは数%。それより大きいのはマークのきわの明るい縁や影の境目なので、写す元にしない
        if (cleanTex[j] && Math.abs(resid[j]) < 0.08) { tex[i] = resid[j]; got[i] = 1; break; }
      }
    }
  }

  // インクの部分だけ置き換える（ふちはなめらかに）
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) if (erase[i]) alpha[i] = 1;
  gaussianBlur(alpha, cw, ch, 1.2);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x, a = alpha[i];
      if (a <= 0.001) continue;
      const t = 1 + tex[i], o = 4 * ((y0 + y) * W + x0 + x);
      d[o] = to8bit(R[i] * (1 - a) + fillR[i] * t * a);
      d[o + 1] = to8bit(G[i] * (1 - a) + fillG[i] * t * a);
      d[o + 2] = to8bit(B[i] * (1 - a) + fillB[i] * t * a);
    }
  }
  return true;
}

/** 手：カードの外から内側へ入り込んでいる肌色の塊（絵札の絵は白い縁を越えない。理由は Swift 側） */
function handReachingIn(Rs, Gs, Bs, inside, paperLike, pc, w, h, cardW) {
  const n = w * h;
  const skinColor = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (paperLike[i]) continue;
    const s = Rs[i] + Gs[i] + Bs[i] + 1e-6;
    const r = Rs[i] / s, g = Gs[i] / s, b = Bs[i] / s;
    const dr = r - pc[0], dg = g - pc[1], db = b - pc[2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) > 0.04 && r - g > 0.02 && g - b > 0.015 && r - Math.max(g, b) < 0.45) skinColor[i] = 1;
  }
  const hand = new Uint8Array(n);
  for (const blob of regions(skinColor, w, h, Math.floor(n / 500))) {
    let inCount = 0, outCount = 0;
    for (const i of blob) { if (inside[i]) inCount++; else outCount++; }
    if (inCount <= 200 || outCount <= 200) continue;
    for (const i of blob) if (inside[i]) hand[i] = 1;
  }
  const r = Math.max(5, Math.floor(cardW * 0.03));
  dilate(hand, w, h, r);
  erode(hand, w, h, r);
  fillEnclosedHoles(hand, w, h);
  dilate(hand, w, h, 1);
  return hand;
}

/** 点 [x, y, ...値] の値（列 col）に 2次式 c0 + c1 x + c2 y + c3 x² + c4 xy + c5 y² を最小二乗で当てはめる */
function fitQuadratic(pts, col) {
  const A = Array.from({ length: 6 }, () => new Float64Array(7));
  for (const p of pts) {
    const x = p[0], y = p[1], v = p[col];
    const f = [1, x, y, x * x, x * y, y * y];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) A[r][c] += f[r] * f[c];
      A[r][6] += f[r] * v;
    }
  }
  for (let c0 = 0; c0 < 6; c0++) {
    let piv = c0;
    for (let r = c0 + 1; r < 6; r++) if (Math.abs(A[r][c0]) > Math.abs(A[piv][c0])) piv = r;
    if (Math.abs(A[piv][c0]) <= 1e-9) return null;
    [A[c0], A[piv]] = [A[piv], A[c0]];
    for (let r = 0; r < 6; r++) {
      if (r === c0) continue;
      const k = A[r][c0] / A[c0][c0];
      for (let c = c0; c < 7; c++) A[r][c] -= k * A[c0][c];
    }
  }
  return Array.from({ length: 6 }, (_, r) => A[r][6] / A[r][r]);
}

// MARK: - 合成

/**
 * 白紙の写真に、乗算でインクを焼き込む。photo は元の大きさの RGBA。
 * 返すのは書き換えた範囲だけ：{ x, y, width, height, data }（元の写真のその位置に重ねる）。
 * blurredFinger は内カメラのとき true（ぼやけた指のもやの下にも印刷を透かす）
 */
export function composite(face, quad, photo, blurredFinger = false) {
  const W = photo.width, H = photo.height;
  const cardW = len(sub(quad[1], quad[0]));
  const margin = cardW * 0.04;
  const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - margin));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - margin));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs) + margin));
  const y1 = Math.min(H, Math.ceil(Math.max(...ys) + margin));
  const cw = x1 - x0, ch = y1 - y0;
  if (cw <= 10 || ch <= 10) return null;
  const n = cw * ch;

  // 作業する範囲を切り出す
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < ch; y++) {
    out.set(photo.data.subarray(4 * ((y0 + y) * W + x0), 4 * ((y0 + y) * W + x1)), 4 * y * cw);
  }
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) { R[i] = FROM8[out[4 * i]]; G[i] = FROM8[out[4 * i + 1]]; B[i] = FROM8[out[4 * i + 2]]; }

  // 絵柄を写真のボケに合わせてぼかす（カード上の座標でぼかしてから貼る）
  const ratio = CARD_W / cardW;
  const sigmaPhoto = Math.max(0.6, cardW / 900);
  const sigmaCard = Math.sqrt(sigmaPhoto * sigmaPhoto + 0.25) * ratio;
  const fr = face.r.slice(), fg = face.g.slice(), fb = face.b.slice();
  gaussianBlur(fr, CARD_W, CARD_H, sigmaCard);
  gaussianBlur(fg, CARD_W, CARD_H, sigmaCard);
  gaussianBlur(fb, CARD_W, CARD_H, sigmaCard);

  const local = quad.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
  const cardCorners = [{ x: 0, y: 0 }, { x: CARD_W, y: 0 }, { x: CARD_W, y: CARD_H }, { x: 0, y: CARD_H }];
  const toCard = homography(local, cardCorners), toPhoto = homography(cardCorners, local);
  if (!toCard || !toPhoto) return null;

  // 写真の各画素に、カード上の対応する点の透過率を持ってくる
  const TR = new Float32Array(n).fill(1), TG = new Float32Array(n).fill(1), TB = new Float32Array(n).fill(1);
  const inside = new Float32Array(n);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const [u, v] = toCard(x + 0.5, y + 0.5);
      if (!(u >= 0 && v >= 0 && u < CARD_W - 1 && v < CARD_H - 1)) continue;
      const ui = Math.floor(u), vi = Math.floor(v), fu = u - ui, fv = v - vi;
      const k = vi * CARD_W + ui;
      const i = y * cw + x;
      const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
      TR[i] = fr[k] * w00 + fr[k + 1] * w10 + fr[k + CARD_W] * w01 + fr[k + CARD_W + 1] * w11;
      TG[i] = fg[k] * w00 + fg[k + 1] * w10 + fg[k + CARD_W] * w01 + fg[k + CARD_W + 1] * w11;
      TB[i] = fb[k] * w00 + fb[k + 1] * w10 + fb[k + CARD_W] * w01 + fb[k + CARD_W + 1] * w11;
      inside[i] = 1;
    }
  }

  // 紙の色（カード内側の中央値）
  const sr = [], sg = [], sb = [], paperSamples = [];
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      const [x, y] = toPhoto(CARD_W * (0.08 + 0.84 * i / 39), CARD_H * (0.08 + 0.84 * j / 39));
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 0 || yi < 0 || xi >= cw || yi >= ch) continue;
      const k = yi * cw + xi;
      sr.push(R[k]); sg.push(G[k]); sb.push(B[k]); paperSamples.push(k);
    }
  }
  if (sr.length <= 20) return null;
  const median = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
  const paper = [median(sr), median(sg), median(sb)];
  const paperSum = paper[0] + paper[1] + paper[2];
  const pc = paper.map((v) => v / paperSum);
  const plum = 0.2126 * paper[0] + 0.7152 * paper[1] + 0.0722 * paper[2];

  // 「紙らしい画素」にだけインクを乗せる。JPEGの色ノイズで判定が揺れないよう、色はならしてから比べる
  const Rs = R.slice(), Gs = G.slice(), Bs = B.slice();
  gaussianBlur(Rs, cw, ch, 4); gaussianBlur(Gs, cw, ch, 4); gaussianBlur(Bs, cw, ch, 4);
  const lum = new Float32Array(n), colorDistance = new Float32Array(n);
  const offR = new Float32Array(n), offG = new Float32Array(n), offB = new Float32Array(n);
  let paperLike = new Float32Array(n);
  let insideCount = 0;
  const colorScore = (d, tol) => Math.min(Math.max(1 - (d - tol) / 0.035, 0), 1);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const s = Rs[i] + Gs[i] + Bs[i] + 1e-6;
    offR[i] = Rs[i] / s - pc[0]; offG[i] = Gs[i] / s - pc[1]; offB[i] = Bs[i] / s - pc[2];
    colorDistance[i] = Math.sqrt(offR[i] * offR[i] + offG[i] * offG[i] + offB[i] * offB[i]);
    paperLike[i] = colorScore(colorDistance[i], 0.035);
    if (inside[i] > 0.5) insideCount++;
  }
  const strictPaper = paperLike.slice();   // 紙の色からほとんどずれていない＝確実に紙

  const texture = textureInfo(out, cw, ch, cardW, strictPaper, inside, paperSamples);

  // 内カメラ かつ 布目が写っていないときだけ、ぼやけた指のもやの下にも印刷を透かす（理由は Swift 側）
  if (blurredFinger && !texture) {
    const blend = blurredFingerPaperLike(offR, offG, offB, colorDistance, lum, plum, inside, n);
    if (blend) paperLike = blend;
  }
  for (let i = 0; i < n; i++) {
    // 布目がはっきりある場所は紙で間違いないので、色のずれを広めに許す
    if (texture && texture.map[i] > 0.6 * texture.paper) paperLike[i] = colorScore(colorDistance[i], 0.09);
    paperLike[i] *= Math.min(Math.max((lum[i] / plum - 0.25) / 0.2, 0), 1);   // 暗すぎる＝紙ではない
  }

  // 爪のツヤや爪の先は、色では紙と区別できないが、布目がない。使うのは指の近くだけ
  const lowTexture = new Uint8Array(n);
  if (texture) {
    const nearSkin = new Float32Array(n);
    for (let i = 0; i < n; i++) if (inside[i] > 0.5 && paperLike[i] < 0.5) nearSkin[i] = 1;
    gaussianBlur(nearSkin, cw, ch, cardW / 30);
    for (let i = 0; i < n; i++) if (nearSkin[i] > 0.1 && texture.map[i] < 0.45 * texture.paper) lowTexture[i] = 1;
  }

  // 確実に紙の部分のうち、カード本体とつながった大きな領域を「起点」にする
  const binary = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (strictPaper[i] > 0.5 && inside[i] > 0.5 && !lowTexture[i]) binary[i] = 1;
  const connected = keepLargeRegions(binary, cw, ch, Math.floor(insideCount / 50));
  fillHoles(connected, inside, cw, ch);

  // 起点から「紙らしさが下がっていく方向」にだけ広げる（爪のツヤは間に指の谷を挟むので消える）
  const limit = paperLike.slice();
  for (let i = 0; i < n; i++) if (inside[i] < 0.5 || lowTexture[i]) limit[i] = 0;
  const marker = new Float32Array(n);
  for (let i = 0; i < n; i++) if (connected[i]) marker[i] = limit[i];
  reconstructByDilation(marker, limit, cw, ch);
  paperLike = marker;
  gaussianBlur(paperLike, cw, ch, 1.5);

  // テカリ：反射光はインクの上から足される。乗算はその分を除いて行ってから足し戻す
  const lumSmooth = lum.slice();
  gaussianBlur(lumSmooth, cw, ch, cardW / 60);
  for (let i = 0; i < n; i++) {
    const spec = Math.max(0, lumSmooth[i] - plum * 1.03);
    const s = inside[i] * paperLike[i];
    out[4 * i] = to8bit((R[i] - spec) * (1 - s * (1 - TR[i])) + spec);
    out[4 * i + 1] = to8bit((G[i] - spec) * (1 - s * (1 - TG[i])) + spec);
    out[4 * i + 2] = to8bit((B[i] - spec) * (1 - s * (1 - TB[i])) + spec);
  }
  return { x: x0, y: y0, width: cw, height: ch, data: out };
}

/** ピントの外れた指がかかった写真用の「紙らしさ」（紙(0)〜指(1)の色のずれで、指に近いほど薄く） */
function blurredFingerPaperLike(offR, offG, offB, colorDistance, lum, plum, inside, n) {
  const sr = [], sg = [], sb = [];
  for (let i = 0; i < n; i += 3) {
    if (inside[i] > 0.5 && colorDistance[i] > 0.08 && lum[i] > 0.15 * plum) { sr.push(offR[i]); sg.push(offG[i]); sb.push(offB[i]); }
  }
  if (sr.length <= 300) return null;
  const median = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const d = [median(sr), median(sg), median(sb)];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (dd <= 0.06 * 0.06) return null;
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (offR[i] * d[0] + offG[i] * d[1] + offB[i] * d[2]) / dd;
    const pr = offR[i] - a * d[0], pg = offG[i] - a * d[1], pb = offB[i] - a * d[2];
    const across = Math.sqrt(pr * pr + pg * pg + pb * pb);
    const ink = Math.min(Math.max((1 - a) / 0.65, 0), 1);
    result[i] = Math.min(ink, Math.min(Math.max(1 - (across - 0.035) / 0.035, 0), 1));
  }
  return result;
}

/** 細かい凹凸（布目）の強さの画像と、紙の典型的な強さ。布目で紙と肌の差が出なければ null */
function textureInfo(px, w, h, cardW, paperLike, inside, samples) {
  const n = w * h;
  const k = Math.max(1, cardW / 1200);
  const lum8 = new Float32Array(n);
  for (let i = 0; i < n; i++) lum8[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
  const base = lum8.slice();
  gaussianBlur(base, w, h, 1.5 * k);
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) { const d = lum8[i] - base[i]; energy[i] = d * d; }
  gaussianBlur(energy, w, h, 4 * k);
  const local = lum8.slice();
  gaussianBlur(local, w, h, 4 * k);
  const texture = new Float32Array(n);
  for (let i = 0; i < n; i++) texture[i] = Math.sqrt(energy[i]) / Math.max(local[i], 1);

  const paperTexture = samples.map((i) => texture[i]).sort((a, b) => a - b)[samples.length >> 1];
  const skin = [];
  for (let i = 0; i < n; i += 7) if (inside[i] > 0.5 && paperLike[i] < 0.2) skin.push(texture[i]);
  if (!skin.length) return null;
  skin.sort((a, b) => a - b);
  if (paperTexture <= 1.8 * skin[skin.length >> 1]) return null;
  return { map: texture, paper: paperTexture };
}
