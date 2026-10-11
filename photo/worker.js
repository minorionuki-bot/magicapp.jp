// 重い処理（カードの検出と焼き込み）を画面とは別に動かす。画面がカクつかないように
import { findCard, eraseInk, composite, downscale, makeCardFace, CARD_W, CARD_H } from './printer.js';

let face = null;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'face') {
      face = makeCardFace({ width: CARD_W, height: CARD_H, data: m.data });
      self.postMessage({ type: 'face', id: m.id });
    } else if (m.type === 'detect') {
      // 撮る前の枠：すでに長辺1200px程度に縮めた映像の1コマ
      const corners = findCard({ width: m.width, height: m.height, data: m.data }, 1);
      self.postMessage({ type: 'detect', id: m.id, corners, width: m.width, height: m.height });
    } else if (m.type === 'print') {
      const photo = { width: m.width, height: m.height, data: m.data };
      const t0 = performance.now();
      const { image: small, scale } = downscale(photo, 1200);
      const corners = findCard(small, scale);
      const t1 = performance.now();
      // 印刷されたカード（絵札以外）なら、先にインクを消してから焼き込む
      const erased = corners && face ? eraseInk(corners, photo) : false;
      const patch = corners && face ? composite(face, corners, photo, m.front) : null;
      const t2 = performance.now();
      const msg = { type: 'print', id: m.id, found: !!corners, erased, patch, detectMs: t1 - t0, printMs: t2 - t1 };
      self.postMessage(msg, patch ? [patch.data.buffer] : []);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};
