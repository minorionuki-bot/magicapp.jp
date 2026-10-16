// 重い処理（カードの検出と焼き込み）を画面とは別に動かす。画面がカクつかないように
// printer.js は worker.js と同じ版を読む（版の印 ?v=… は公開のときに付く。古い版を覚えていたブラウザで、
// 新しい本体と古い部品が混ざって止まったことがある。2026-10-13）
let findCard, eraseInk, composite, downscale, makeCardFace, parseCardIndex, identifyCard, alignMarks, CARD_W, CARD_H;
// 命令を受けてから、読み込みが終わるのを待つ（読み込み中に届いた命令を取りこぼさないよう、受け口は先に用意する）
const ready = import(`./printer.js${self.location.search}`).then((m) => ({ findCard, eraseInk, composite, downscale, makeCardFace, parseCardIndex, identifyCard, alignMarks, CARD_W, CARD_H } = m));

// 印刷されたカードを当てるための索引と、当たったカードの素材（一度読んだものは取っておく）
let indexPromise = null;
const templates = new Map();
function cardIndex() {
  indexPromise ??= ready.then(() => fetch(`cards/index.bin${self.location.search}`)).then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? parseCardIndex(b) : null)).catch(() => null);
  return indexPromise;
}
// 見分ける用の素材があるカード（画面に出す絵柄から文字を消した ♠A・アプリから外したジョーカー。理由は Swift 側と tools/compress_cards.py）
const MATCH_ONLY = new Set(['AS', 'JK1', 'JK2']);
async function template(name) {
  if (!templates.has(name)) {
    templates.set(name, (async () => {
      const file = MATCH_ONLY.has(name) ? `${name}_match` : name;
      const res = await fetch(`cards/${file}.webp${self.location.search}`);
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
let analyzed = null;
let lastPrefetch = 0;   // 撮る前に素材を読み込んだ時刻   // analyze の結果（compose で使う）

self.onmessage = async (e) => {
  const m = e.data;
  try {
    await ready;
    if (m.type === 'face') {
      face = m.data ? makeCardFace({ width: CARD_W, height: CARD_H, data: m.data }) : null;   // null＝絵柄の素材なし
      self.postMessage({ type: 'face', id: m.id });
    } else if (m.type === 'detect') {
      // 撮る前の枠：すでに長辺640pxに縮めた映像の1コマ
      const frame = { width: m.width, height: m.height, data: m.data };
      const corners = findCard(frame, 1, m.hint);
      self.postMessage({ type: 'detect', id: m.id, corners, width: m.width, height: m.height });
      // 撮る前のうちに、映っている印刷カードを当てて、その素材を読み込んでおく（撮ったあとに通信で取りにいくと、
      // そのぶん保存まで待たせた。2026-10-14）。1秒に1回まで
      if (corners && performance.now() - lastPrefetch > 1000) {
        lastPrefetch = performance.now();
        const index = await cardIndex();
        const found = index && identifyCard(corners, frame, index);
        if (found) template(found.name);
      }
    } else if (m.type === 'analyze') {
      // 撮った写真のカードを探し、印刷されたカードなら当てて消すところまで（どのカードに変えるかに関係しない部分）。
      // 演者の設定を読み直す通信と同時に進めるため、焼き込み（compose）と分けてある
      const photo = { width: m.width, height: m.height, data: m.data };
      const t0 = performance.now();
      // 縮小した写真は app.js が描画機能で作って渡す（なければここで作る）
      const { image: small, scale } = m.small
        ? { image: { width: m.small.width, height: m.small.height, data: m.small.data }, scale: m.small.scale }
        : downscale(photo, 1200);
      const corners = findCard(small, scale, m.hint);   // hint：タップで示された位置（割合）
      const t1 = performance.now();
      const expected = corners ? await expectedMarks(corners, photo) : null;
      const t2 = performance.now();
      const erased = corners ? eraseInk(corners, photo, expected) : false;
      const t3 = performance.now();
      analyzed = { id: m.id, photo, corners, erased, front: m.front };
      self.postMessage({ type: 'analyze', id: m.id, found: !!corners, erased,
        detectMs: t1 - t0, matchMs: t2 - t1, eraseMs: t3 - t2 });
    } else if (m.type === 'compose') {
      // 直前に analyze した写真に、今のカードを焼き込む
      const a = analyzed;
      analyzed = null;
      const t0 = performance.now();
      const patch = a && a.corners && face ? composite(face, a.corners, a.photo, a.front) : null;
      self.postMessage({ type: 'compose', id: m.id, hasFace: !!face, patch, composeMs: performance.now() - t0 },
        patch ? [patch.data.buffer] : []);
    } else {
      self.postMessage({ type: 'error', id: m.id, message: `知らない命令: ${m.type}` });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
  }
};
