// 重い処理（カードの検出と焼き込み）を画面とは別に動かす。画面がカクつかないように
import { findCard, eraseInk, composite, downscale, makeCardFace, parseCardIndex, identifyCard, alignMarks, CARD_W, CARD_H } from './printer.js';

// 印刷されたカードを当てるための索引と、当たったカードの素材（一度読んだものは取っておく）
let indexPromise = null;
const templates = new Map();
function cardIndex() {
  indexPromise ??= fetch('cards/index.bin').then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? parseCardIndex(b) : null)).catch(() => null);
  return indexPromise;
}
async function template(name) {
  if (!templates.has(name)) {
    templates.set(name, (async () => {
      const res = await fetch(`cards/${name}.webp`);
      if (!res.ok) return null;
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(CARD_W, CARD_H);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, CARD_W, CARD_H);
      return makeCardFace(ctx.getImageData(0, 0, CARD_W, CARD_H));
    })().catch(() => null));
  }
  return templates.get(name);
}
cardIndex();

/** 印刷されたカードなら、どのカードかを当てて、マークと数字のある場所を返す（当てられなければ null） */
async function expectedMarks(corners, photo) {
  const found = identifyCard(corners, photo, await cardIndex());
  if (!found) return null;
  const face = await template(found.name);
  return face ? alignMarks(found, face) : null;
}

let face = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'face') {
      face = m.data ? makeCardFace({ width: CARD_W, height: CARD_H, data: m.data }) : null;   // null＝絵柄の素材なし
      self.postMessage({ type: 'face', id: m.id });
    } else if (m.type === 'detect') {
      // 撮る前の枠：すでに長辺1200px程度に縮めた映像の1コマ
      const corners = findCard({ width: m.width, height: m.height, data: m.data }, 1, m.hint);
      self.postMessage({ type: 'detect', id: m.id, corners, width: m.width, height: m.height });
    } else if (m.type === 'print') {
      const photo = { width: m.width, height: m.height, data: m.data };
      const t0 = performance.now();
      const { image: small, scale } = downscale(photo, 1200);
      const corners = findCard(small, scale, m.hint);   // hint：タップで示された位置（割合）
      const t1 = performance.now();
      // 印刷されたカードなら、先に印刷を消してから焼き込む（絵札は非推奨だが消せる）
      const cardFace = face;   // 待っている間に選び直されても、押した時点のカードで焼き込む
      const expected = corners && cardFace ? await expectedMarks(corners, photo) : null;
      const erased = corners && cardFace ? eraseInk(corners, photo, expected) : false;
      const patch = corners && cardFace ? composite(cardFace, corners, photo, m.front) : null;
      const t2 = performance.now();
      const msg = { type: 'print', id: m.id, found: !!corners, hasFace: !!cardFace, erased, patch, detectMs: t1 - t0, printMs: t2 - t1 };
      self.postMessage(msg, patch ? [patch.data.buffer] : []);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};
