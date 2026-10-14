// ブラウザ版の撮影画面。iPhone の標準カメラに似せた見た目で、撮る前にカードを認識したら黄色の枠を出し、
// 撮ったら裏で焼き込む。保存は「左下のサムネイル → 共有 → 画像を保存」の2タップ
// （ブラウザは処理が終わってから自動で共有画面を開けないため）。
// サムネイルには焼き込む前の白紙の写真を出し、保存されるのは焼き込み済みの写真（その場でネタが割れない）。
import { CARD_W, CARD_H } from './printer.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// 54枚の記号と名前（記号は「数字＋マーク」かジョーカー。絵柄は cards/<記号>.webp）
const SUITS = { S: 'スペード', H: 'ハート', D: 'ダイヤ', C: 'クラブ' };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const CARDS = { JK1: 'ジョーカー1', JK2: 'ジョーカー2' };
for (const [s, name] of Object.entries(SUITS)) for (const r of RANKS) CARDS[r + s] = `${name}の${r}`;
const $ = (id) => document.getElementById(id);
const video = $('video'), preview = $('preview'), frameEl = $('frame');

// MARK: 裏の処理（worker）とのやりとり

// 置き場所は app.js 自身の場所から数える。短いリンク（magicapp.jp/12345）のページは <base href="/photo/"> に頼っているが、
// Safari はそれを無視することがあり、アドレス（/12345）から数えて読み込みに失敗した（2026-10-13）
const here = (path) => new URL(path, import.meta.url).href;
// 版の印（公開のときに index.html が app.js?v=… と付けて読む）を worker にも引き継ぐ
const worker = new Worker(here(`./worker.js${new URL(import.meta.url).search}`), { type: 'module' });
let nextId = 1;
const pending = new Map();
worker.onmessage = (e) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  e.data.type === 'error' ? p.reject(new Error(e.data.message)) : p.resolve(e.data);
};
function call(msg, transfer = [], timeout = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
    // 返事が来ないまま止まらないように（裏の処理が落ちた・古い版が混ざった など）
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`裏の処理から返事がない（${msg.type}）`));
    }, timeout);
  });
}

// MARK: 変化させるカード
// 本番は URL の ?id=（本体アプリが発行したリンク）で、カードはクラウドから読む。演者がアプリでカードを選び直すと、
// 同じリンクのまま変わる（撮る直前まで変えられるよう、シャッターを押した瞬間にも読み直す）。
// ?card=KH は試験用

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}
const params = new URLSearchParams(location.search);
const linkId = params.get('id');
// 短いリンク（magicapp.jp/12345）。magicapp.jp の 404.html がこのページを出すので、アドレスは5桁の番号のまま
const shortMatch = location.pathname.match(/^\/(\d{5})\/?$/);
const linkCode = shortMatch ? Number(shortMatch[1]) : null;
let card = params.get('card');
if (!CARDS[card]) card = storage('card');
if (!CARDS[card]) card = 'KH';
let faceReady = loadFace(card);

/** クラウドからこのリンクのカードを読む。読めなければ null（timeoutMs で諦める） */
async function fetchLinkCard(timeoutMs) {
  if (!linkId && !linkCode) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const [fn, body] = linkId ? ['magicphoto_get', { p_id: linkId }] : ['magicphoto_get_by_code', { p_code: linkCode }];
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const value = await res.json();
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** リンクのカードに合わせる（変わっていれば絵柄を読み直す） */
async function syncLinkCard(timeoutMs) {
  const latest = await fetchLinkCard(timeoutMs);
  if (latest && CARDS[latest] && latest !== card) {
    card = latest;
    faceReady = loadFace(card);
  }
  return latest;
}
syncLinkCard(5000);

async function loadFace(name) {
  const res = await fetch(here(`cards/${name}.webp${new URL(import.meta.url).search}`));
  // 絵柄の素材がまだないカード：焼き込まずに元の写真をそのまま保存する（お客さんには普通の写真に見える）
  if (!res.ok) { await call({ type: 'face', data: null }); return; }
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, CARD_W, CARD_H);
  const data = ctx.getImageData(0, 0, CARD_W, CARD_H).data;
  await call({ type: 'face', data }, [data.buffer]);
}

// MARK: カメラ

let front = storage('front') === '1';   // 本番は基本的に背面カメラ
let stream = null;

// カメラが映らないまま止まったとき、何を待っているかを画面に出す（iPhone でだけ起きて、Mac では再現できないため）
let cameraStep = '';
function showCameraWait() {
  if (video.videoWidth) return;
  $('message').textContent = `カメラが起動しません（${cameraStep}）。\nページを読み込み直すか、Safari の設定でカメラを「許可」にしてください。`;
  $('message').style.display = 'flex';
}
window.addEventListener('error', (e) => { cameraStep = `エラー: ${e.message}`; showCameraWait(); });
window.addEventListener('unhandledrejection', (e) => { cameraStep = `エラー: ${e.reason}`; showCameraWait(); });

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  preview.classList.toggle('mirror', front);
  cameraStep = '許可を待っています';
  const waitTimer = setTimeout(showCameraWait, 3000);
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではカメラを使えません');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // できるだけ高い解像度で（ブラウザが出せる範囲に自動で丸められる）
      video: { facingMode: front ? 'user' : 'environment', width: { ideal: 4032 }, height: { ideal: 3024 } },
    });
    cameraStep = '映像を待っています';
    video.srcObject = stream;
    await video.play();
    cameraStep = '映像の大きさを待っています';
    clearTimeout(waitTimer);
    $('message').style.display = 'none';
  } catch (err) {
    clearTimeout(waitTimer);
    $('message').textContent = 'カメラを使えません。\n' + (location.protocol !== 'https:' ? 'https で開いてください。' : String(err));
    $('message').style.display = 'flex';
  }
}

$('flip').onclick = () => {
  front = !front;
  tapHint = null;
  storage('front', front ? '1' : '0');
  live = null;
  showFrame();
  startCamera();
};

// MARK: 撮る前の枠（映像を1秒に5回ほど取り出して、撮影時と同じ検出にかける）

// 画面をタップして示した「カードはここ」。映像に対する割合（鏡像にしない向き＝検出と保存する写真の向き）。
// ブラウザではピントは動かせないので、場所の手がかりにだけ使う。カードを動かしたあとまで古い場所を使わないよう30秒で切る
let tapHint = null;   // { x, y, at }
const currentHint = () => (tapHint && performance.now() - tapHint.at < 30000 ? { x: tapHint.x, y: tapHint.y } : null);

preview.addEventListener('click', (e) => {
  if (!video.videoWidth) return;
  const rect = preview.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const W = rect.width, H = rect.height, aspect = video.videoWidth / video.videoHeight;
  const scale = Math.max(W / aspect, H);
  const shownW = aspect * scale, shownH = scale;
  let x = (px - (W - shownW) / 2) / shownW;
  const y = (py - (H - shownH) / 2) / shownH;
  if (front) x = 1 - x;   // プレビューは鏡像
  tapHint = { x, y, at: performance.now() };
  showFocus(px, py);
});

/** 標準のカメラのピント合わせの四角：少し大きく出て縮み、しばらくして薄くなる */
function showFocus(x, y) {
  const old = $('focus');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'focus';
  el.style.left = `${x - 38}px`;
  el.style.top = `${y - 38}px`;
  preview.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('settled')));
  setTimeout(() => el.classList.add('faded'), 1200);
}

let live = null;        // { corners: 映像に対する割合 0〜1, aspect: 映像の 幅÷高さ }
let lastSeen = 0;
let detecting = false;
const detectCanvas = new OffscreenCanvas(1, 1);

setInterval(async () => {
  if (detecting || video.readyState < 2 || !video.videoWidth || document.hidden) return;
  detecting = true;
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(1, 1200 / Math.max(vw, vh));
    const w = Math.round(vw * s), h = Math.round(vh * s);
    detectCanvas.width = w; detectCanvas.height = h;
    const ctx = detectCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const r = await call({ type: 'detect', width: w, height: h, data, hint: currentHint() }, [data.buffer]);
    if (r.corners) {
      // プレビューは内カメラだと鏡像なので、枠も左右を反転して重ねる
      let corners = r.corners.map((p) => ({ x: p.x / w, y: p.y / h }));
      if (front) corners = corners.map((p) => ({ x: 1 - p.x, y: p.y }));
      // 検出結果に毎回飛びつかず、前の位置から少しずつ寄せる（枠をカクカクさせない）
      if (live) corners = corners.map((p, i) => ({ x: live.corners[i].x * 0.6 + p.x * 0.4, y: live.corners[i].y * 0.6 + p.y * 0.4 }));
      live = { corners, aspect: w / h };
      lastSeen = performance.now();
    } else if (performance.now() - lastSeen > 500) {
      live = null;   // 一瞬見失っただけで枠がちらつかないよう、少しのあいだは前の枠を出しておく
    }
    showFrame();
  } catch (err) {
    console.warn(err);
  } finally {
    detecting = false;
  }
}, 200);

/** 枠はカードと同じ縦横比（1:1.4）の角丸の四角で、カードの傾きと縦・横に合わせて回す */
function showFrame() {
  if (!live) { frameEl.classList.remove('on'); return; }
  const W = preview.clientWidth, H = preview.clientHeight;
  // 映像は枠いっぱいに拡大して、はみ出しを切っている（object-fit: cover）
  const scale = Math.max(W / live.aspect, H);
  const shownW = live.aspect * scale, shownH = scale;
  const p = live.corners.map((c) => ({ x: (W - shownW) / 2 + c.x * shownW, y: (H - shownH) / 2 + c.y * shownH }));
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const center = { x: (p[0].x + p[1].x + p[2].x + p[3].x) / 4, y: (p[0].y + p[1].y + p[2].y + p[3].y) / 4 };
  const shortSide = (d(p[0], p[1]) + d(p[3], p[2])) / 2, longSide = (d(p[0], p[3]) + d(p[1], p[2])) / 2;
  const short = Math.sqrt(Math.max(shortSide * longSide, 1) / 1.4);   // 面積が同じで、縦横比がカードと同じ四角
  const ax = (p[3].x - p[0].x) + (p[2].x - p[1].x), ay = (p[3].y - p[0].y) + (p[2].y - p[1].y);
  let angle = Math.atan2(ay, ax) - Math.PI / 2;
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  const fw = short * 1.12, fh = short * 1.4 * 1.12;
  frameEl.style.width = `${fw}px`;
  frameEl.style.height = `${fh}px`;
  frameEl.style.transform = `translate(${center.x - fw / 2}px, ${center.y - fh / 2}px) rotate(${angle}rad)`;
  frameEl.classList.add('on');
}

// MARK: 撮影 → 焼き込み

let lastFile = null;

$('shutter').onclick = async () => {
  if (!video.videoWidth) return;
  $('flash').classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => $('flash').classList.remove('on')));
  const vw = video.videoWidth, vh = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = vw; canvas.height = vh;
  canvas.getContext('2d').drawImage(video, 0, 0, vw, vh);   // 保存する写真は鏡像にしない（標準のカメラと同じ）
  await processPhoto(canvas, front, currentHint());
};

async function processPhoto(canvas, isFront, hint = null) {
  const start = performance.now();
  showThumbnail(canvas);   // サムネイルは焼き込む前の白紙の写真
  lastFile = null;
  shareWanted = 0;
  $('thumb').classList.add('busy');
  saveHint('準備中…', true);
  // 撮る直前に演者がカードを選び直していても間に合うよう、シャッターを押した瞬間にも読み直す。
  // 読み直す通信は、カードを探して印刷を消す処理（どのカードに変えるかに関係しない）と同時に進める
  const syncing = syncLinkCard(1500);
  const log = [`${canvas.width}x${canvas.height} ${isFront ? '内カメラ' : '背面カメラ'}`
    + (hint ? ` タップ ${hint.x.toFixed(2)},${hint.y.toFixed(2)}` : '')];
  const ms = (x) => `${(x / 1000).toFixed(2)}秒`;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const t0 = performance.now();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const tRead = performance.now() - t0;
    const a = await call({ type: 'analyze', width: canvas.width, height: canvas.height, data, front: isFront, hint }, [data.buffer]);
    const latest = await syncing;
    await faceReady;
    log.push(`${CARDS[card]}` + (linkId || linkCode ? (latest ? '（リンクから）' : '（リンクを読めず、前のカード）') : ''));
    const r = await call({ type: 'compose' });
    log.push(`読み取り ${ms(tRead)} / 検出 ${ms(a.detectMs)} / 当てる ${ms(a.matchMs)} / 消す ${ms(a.eraseMs)} / 焼き込み ${ms(r.composeMs)}`);
    if (r.patch) {
      ctx.putImageData(new ImageData(r.patch.data, r.patch.width, r.patch.height), r.patch.x, r.patch.y);
      log.push(a.erased ? '元の印刷を消して焼き込み成功' : '焼き込み成功');
    } else {
      // 見つからなかったときは元の写真をそのまま保存する（お客さんには普通の写真に見える）
      log.push(!r.hasFace ? 'このカードの絵柄がまだない（元の写真を保存）' : 'カードが見つからない（元の写真を保存）');
    }
    const t1 = performance.now();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    lastFile = new File([blob], `IMG_${Date.now() % 10000}.JPG`, { type: 'image/jpeg' });
    log.push(`JPEG ${ms(performance.now() - t1)}`);
    log.push(`保存の準備ができました（${((performance.now() - start) / 1000).toFixed(1)}秒）`);
  } catch (err) {
    log.push('失敗: ' + err.message);
  }
  // 失敗しても、撮った写真（焼き込めたところまで）は保存できるようにする（お客さんには普通の写真に見える）
  if (!lastFile) {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    if (blob) lastFile = new File([blob], `IMG_${Date.now() % 10000}.JPG`, { type: 'image/jpeg' });
  }
  $('log').textContent = log.join('\n');
  $('thumb').classList.remove('busy');
  saveHint(lastFile ? 'タップして保存 ↓' : '');
  readyToShare();
  return lastFile;
}

function showThumbnail(source) {
  const t = document.createElement('canvas');
  const s = 160 / Math.max(source.width, source.height);
  t.width = Math.round(source.width * s); t.height = Math.round(source.height * s);
  t.getContext('2d').drawImage(source, 0, 0, t.width, t.height);
  $('thumb').style.backgroundImage = `url(${t.toDataURL('image/jpeg', 0.8)})`;
  $('thumb').classList.remove('empty');
}

// サムネイル → 共有画面（「画像を保存」でカメラロールへ）。
// 以前は焼き込みが終わる前（撮ってから数秒）に押しても何も起きず、何度も押してやっと開く状態だった（2026-10-13）。
// 処理中に押されたら覚えておき、終わったら自動で開く。ただし Safari はタップから約5秒を過ぎると自動では開かせないので、
// それより遅れたときはサムネイルを弾ませて「押せる」と知らせる
let shareWanted = 0;   // 処理中にサムネイルが押された時刻（0＝押されていない）
let sharing = false;

/** サムネイルの横の案内（何を押せばいいか）。text が空なら消す */
function saveHint(text, waiting = false) {
  const h = $('saveHint');
  if (text) h.textContent = text;
  h.classList.toggle('on', !!text);
  h.classList.toggle('wait', waiting);
}

/** 焼き込んだ写真を画面いっぱいに一瞬見せる（共有画面はこの上に開く） */
let peekURL = null;
function peek() {
  if (!lastFile) return;
  if (peekURL) URL.revokeObjectURL(peekURL);
  peekURL = URL.createObjectURL(lastFile);
  const el = $('peek');
  el.style.backgroundImage = `url(${peekURL})`;
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 1000);
}

async function share() {
  if (!lastFile || sharing) return true;
  // 共有画面はタップから時間がたつと開けないので、写真を見せるのと同時に開く
  peek();
  if (navigator.canShare?.({ files: [lastFile] })) {
    sharing = true;
    try {
      await navigator.share({ files: [lastFile] });
      saveHint('');   // 保存の流れが終わったら案内は消す
    } catch (err) {
      sharing = false;
      // AbortError は共有画面を閉じただけ。それ以外（自動で開くのを Safari が許さなかった など）は失敗
      return err?.name === 'AbortError';
    }
    sharing = false;
  } else {
    // 共有できないブラウザ（Macなど）は、画像を新しいタブで開く
    window.open(URL.createObjectURL(lastFile), '_blank');
  }
  return true;
}

function readyToShare() {
  if (!lastFile) return;
  if (shareWanted && performance.now() - shareWanted < 4500) {
    shareWanted = 0;
    share().then((ok) => { if (!ok) bounce(); });
    return;
  }
  shareWanted = 0;
  bounce();
}

function bounce() {
  const t = $('thumb');
  t.classList.remove('ready');
  void t.offsetWidth;   // 同じアニメーションをもう一度動かすため
  t.classList.add('ready');
}

$('thumb').onclick = () => {
  if (lastFile) share();
  else if ($('thumb').classList.contains('busy')) shareWanted = performance.now();
};

// MARK: 演者用メニュー（上の黒い帯を1秒長押し）

let pressTimer = null;
$('top').addEventListener('pointerdown', () => { pressTimer = setTimeout(openMenu, 1000); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('top').addEventListener(ev, () => clearTimeout(pressTimer)));
$('closeMenu').onclick = () => $('menu').classList.remove('on');

function openMenu() {
  const list = $('cards');
  list.innerHTML = '';
  for (const [key, name] of Object.entries(CARDS)) {
    const row = document.createElement('div');
    row.className = 'row card' + (key === card ? ' selected' : '');
    row.innerHTML = `<span>${name}</span><span class="check">✓</span>`;
    row.onclick = () => {
      card = key;
      storage('card', key);
      faceReady = loadFace(key);
      $('menu').classList.remove('on');
    };
    list.appendChild(row);
  }
  $('menu').classList.add('on');
}

// 調整用：カメラロールの写真で試す（カメラのない Mac のブラウザでの確認にも使う）
$('testFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  $('log').textContent = '処理中…';
  const out = await processPhoto(canvas, front);
  if (out) {
    $('testResult').src = URL.createObjectURL(out);
    $('testResult').style.display = 'block';
  }
  e.target.value = '';
};

// 画面の大きさが変わったら（Safari のツールバーの出し入れなど）枠を置き直す
window.addEventListener('resize', showFrame);

startCamera();
