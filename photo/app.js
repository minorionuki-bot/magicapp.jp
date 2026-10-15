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
// 自分で登録したカード（Pro。記号は MY-<UUID>）。画像はリンクと一緒にクラウドから届く（server/supabase_005_my_cards.sql）
const isMine = (c) => typeof c === 'string' && /^MY-[0-9A-Fa-f-]{36}$/.test(c);
const isCard = (c) => !!CARDS[c] || isMine(c);
const cardName = (c) => (isMine(c) ? '自分の登録' : CARDS[c]);
const $ = (id) => document.getElementById(id);
const video = $('video'), preview = $('preview'), frameEl = $('frame');

// お客さんに見える文字は、スマホの言語が日本語以外なら英語にする（海外の公演用。2026-10-14）。
// 演者用メニューと記録は演者が読むので日本語のまま
// ?lang=en / ?lang=ja で確かめられる
const langParam = new URLSearchParams(location.search).get('lang');
const EN = langParam ? langParam === 'en' : !/^ja\b/i.test(navigator.language || 'ja');
const T = (ja, en) => (EN ? en : ja);
if (EN) {
  document.documentElement.lang = 'en';
  document.title = 'Camera';
  $('mode').textContent = 'PHOTO';
  $('retake').textContent = 'Retake';
  $('save').textContent = 'Save';
  $('thumb').setAttribute('aria-label', 'Last photo');
  $('shutter').setAttribute('aria-label', 'Shutter');
  $('flip').setAttribute('aria-label', 'Switch camera');
}

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
// 本番は URL の ?id=（本体アプリが発行したリンク）か短いリンクで、カードはクラウドから読む。
// **読むのはリンクを開いたときの1回だけ**（2026-10-14、本人の判断）。演者はカードを決めてからリンクを開くので、
// 撮る瞬間に読み直す必要はない。撮影時に通信しないので、電波の弱い会場でも「読めずに前のカード」にならない。
// 開いたときに読めなければ、読めるまで裏で読み直す。?card=KH は試験用

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
if (!isCard(card) || (isMine(card) && !storage('myFace'))) card = 'KH';
let faceReady = null;
const hasLink = !!(linkId || linkCode);
let linkLoaded = !hasLink;   // リンクのカードを読み終えたか（リンクがなければ読むものはない）

// お客さんのページの設定（演者が本体アプリで選ぶ。2026-10-14）。sound＝保存でシャッター音、review＝保存前の確認画面
const pageOptions = { sound: true, review: true };
// 試験用：?sound=0 / ?review=0 で上書きできる（リンクの設定より後に読むので、こちらが優先）
const optionOverrides = {};
for (const k of Object.keys(pageOptions)) if (params.has(k)) optionOverrides[k] = params.get(k) !== '0';
Object.assign(pageOptions, optionOverrides);

async function rpc(fn, body, signal) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    cache: 'no-store',
  });
  return res;
}

/** クラウドからこのリンクのカード（と設定）を読む。読めなければ null（timeoutMs で諦める） */
async function fetchLinkCard(timeoutMs) {
  if (!linkId && !linkCode) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = linkId ? { p_id: linkId } : { p_code: linkCode };
    // カードと設定をまとめて読む窓口（server/supabase_003_options.sql）。まだなければ今までの窓口でカードだけ読む
    let res = await rpc(linkId ? 'magicphoto_link_by_id' : 'magicphoto_link_by_code', body, ctrl.signal);
    if (res.ok) {
      const v = await res.json();
      if (!v || typeof v.card !== 'string') return null;
      for (const k of Object.keys(pageOptions)) if (typeof v.options?.[k] === 'boolean') pageOptions[k] = v.options[k];
      Object.assign(pageOptions, optionOverrides);
      return { card: v.card, face: typeof v.face === 'string' ? v.face : null };
    }
    res = await rpc(linkId ? 'magicphoto_get' : 'magicphoto_get_by_code', body, ctrl.signal);
    if (!res.ok) return null;
    const value = await res.json();
    return typeof value === 'string' ? { card: value, face: null } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** リンクのカードを読み、絵柄まで準備する。読めるまで間をあけて読み直す */
async function loadLinkCard() {
  for (let attempt = 1; ; attempt++) {
    const value = await fetchLinkCard(5000);
    if (value && (CARDS[value.card] || (isMine(value.card) && value.face))) {
      card = value.card;
      if (value.face) storage('myFace', value.face);
      storage('card', card);   // 次に読めなかったときの「前のカード」
      faceReady = loadFace(card);
      linkLoaded = true;
      return card;
    }
    await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 6000)));
  }
}
const linkReady = hasLink ? loadLinkCard() : Promise.resolve(card);
if (!hasLink) faceReady = loadFace(card);

async function loadFace(name) {
  let blob;
  if (isMine(name)) {
    // 自分の登録：リンクと一緒に届いた JPEG（base64）
    const b64 = storage('myFace');
    if (!b64) { await call({ type: 'face', data: null }); return; }
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    blob = new Blob([bytes], { type: 'image/jpeg' });
  } else {
    const res = await fetch(here(`cards/${name}.webp${new URL(import.meta.url).search}`));
    // 絵柄の素材がまだないカード：焼き込まずに元の写真をそのまま保存する（お客さんには普通の写真に見える）
    if (!res.ok) { await call({ type: 'face', data: null }); return; }
    blob = await res.blob();
  }
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
  $('message').textContent = T(`カメラが起動しません（${cameraStep}）。\nページを読み込み直すか、Safari の設定でカメラを「許可」にしてください。`,
    `The camera did not start (${cameraStep}).\nReload the page, or allow the camera in Safari settings.`);
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
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(T('このブラウザではカメラを使えません', 'This browser cannot use the camera'));
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
    $('message').textContent = T('カメラを使えません。\n', 'Cannot use the camera.\n')
      + (location.protocol !== 'https:' ? T('https で開いてください。', 'Open this page with https.') : String(err));
    $('message').style.display = 'flex';
  }
}

// 低電力モードなどで映像が自動で始まらなかったときは、画面に触れたところで始める（再生ボタンは出さない）
document.addEventListener('pointerdown', () => {
  if (video.srcObject && video.paused) video.play().catch(() => {});
}, { capture: true });

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

let liveSize = 640;     // 撮る前の枠を探すときの長辺（px）
/** 次のコマを探す大きさ：カードが短い辺で70px未満に写っていたか、見つからなければ960px、十分大きければ640px */
function nextLiveSize(corners) {
  if (!corners) return 960;
  const short = Math.min(Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y),
    Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y));
  return short * (640 / liveSize) < 70 ? 960 : 640;
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
    // 撮る前の枠は大まかな位置が分かればよいので、小さく縮めて探す（1200px だと1コマ0.3〜0.5秒かかり、
    // 枠が1秒に2〜3回しか動かず遅れて見えた。2026-10-14）。ふだんは640px。ただしカードが遠くて小さく写ると
    // 640px では見つからなかった（IMG_7116・7117）ので、カードが小さいときと見つからないときは960pxで探す。
    // 撮った写真は今までどおり細かく探す
    const s = Math.min(1, liveSize / Math.max(vw, vh));
    const w = Math.round(vw * s), h = Math.round(vh * s);
    detectCanvas.width = w; detectCanvas.height = h;
    const ctx = detectCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const r = await call({ type: 'detect', width: w, height: h, data, hint: currentHint() }, [data.buffer]);
    liveSize = nextLiveSize(r.corners);
    if (r.corners) {
      // プレビューは内カメラだと鏡像なので、枠も左右を反転して重ねる
      let corners = r.corners.map((p) => ({ x: p.x / w, y: p.y / h }));
      if (front) corners = corners.map((p) => ({ x: 1 - p.x, y: p.y }));
      // 検出結果に毎回飛びつかず、前の位置から少しずつ寄せる（枠をカクカクさせない）
      if (live) corners = corners.map((p, i) => ({ x: live.corners[i].x * 0.45 + p.x * 0.55, y: live.corners[i].y * 0.45 + p.y * 0.55 }));
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
}, 120);

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
  shot = null;
  $('save').disabled = true;
  shareWanted = 0;
  $('thumb').classList.add('busy');
  saveHint(T('準備中…', 'Preparing…'), true);
  // カードはリンクを開いたときに読んである。まだ読めていなければ、カードを探して消す処理と同時に少しだけ待つ
  const cardWait = linkLoaded ? Promise.resolve(true)
    : Promise.race([linkReady.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  const log = [`${canvas.width}x${canvas.height} ${isFront ? '内カメラ' : '背面カメラ'}`
    + (hint ? ` タップ ${hint.x.toFixed(2)},${hint.y.toFixed(2)}` : '')];
  const ms = (x) => `${(x / 1000).toFixed(2)}秒`;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const t0 = performance.now();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // カードを探す用の縮小（長辺1200px）は、ブラウザの描画機能に任せる（1画素ずつ計算すると iPhone で0.5秒前後かかった）
    const ss = Math.min(1, 1200 / Math.max(canvas.width, canvas.height));
    const sc = document.createElement('canvas');
    sc.width = Math.round(canvas.width * ss); sc.height = Math.round(canvas.height * ss);
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, sc.width, sc.height);
    const small = sctx.getImageData(0, 0, sc.width, sc.height).data;
    const tRead = performance.now() - t0;
    const a = await call({ type: 'analyze', width: canvas.width, height: canvas.height, data, front: isFront, hint,
      small: { width: sc.width, height: sc.height, data: small, scale: sc.width / canvas.width } }, [data.buffer, small.buffer]);
    const loaded = await cardWait;
    if (!faceReady) faceReady = loadFace(card);   // リンクをまだ読めていない：前に使ったカード（なければ K♥）で焼き込む
    await faceReady;
    log.push(`${cardName(card)}` + (hasLink ? (loaded ? '（リンクから）' : '（リンクを読めず、前のカード）') : ''));
    const r = await call({ type: 'compose' });
    log.push(`読み取り ${ms(tRead)} / 検出 ${ms(a.detectMs)} / 当てる ${ms(a.matchMs)} / 消す ${ms(a.eraseMs)} / 焼き込み ${ms(r.composeMs)}`);
    if (r.patch) {
      ctx.putImageData(new ImageData(r.patch.data, r.patch.width, r.patch.height), r.patch.x, r.patch.y);
      log.push(a.erased ? '元の印刷を消して焼き込み成功' : '焼き込み成功');
    } else {
      // 見つからなかったときは元の写真をそのまま保存する（お客さんには普通の写真に見える）
      log.push(!r.hasFace ? 'このカードの絵柄がまだない（元の写真を保存）' : 'カードが見つからない（元の写真を保存）');
    }
    log.push(`確認できるまで ${ms(performance.now() - start)}`);
  } catch (err) {
    // 失敗しても、撮った写真（焼き込めたところまで）は保存できるようにする（お客さんには普通の写真に見える）
    log.push('失敗: ' + err.message);
  }
  // 確認画面は、保存用の JPEG ができるのを待たずに出せるようにする（JPEG を作るのに1秒前後かかり、待ち時間が長かった。
  // 2026-10-14）。JPEG はお客さんが確認画面で写真を見ている間に作る
  shot = canvas;
  $('log').textContent = log.join('\n');
  $('thumb').classList.remove('busy');
  saveHint(pageOptions.review ? T('タップして確認・保存 ↓', 'Tap to view & save ↓') : T('タップして保存 ↓', 'Tap to save ↓'));
  readyToShare();
  const t1 = performance.now();
  filePromise = new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92)).then((blob) => {
    if (shot !== canvas || !blob) return null;   // 待っている間に撮り直された
    lastFile = new File([blob], `IMG_${Date.now() % 10000}.JPG`, { type: 'image/jpeg' });
    $('save').disabled = false;
    log.push(`JPEG ${ms(performance.now() - t1)}（確認画面を見ている間に作る）`);
    $('log').textContent = log.join('\n');
    return lastFile;
  });
  return filePromise;
}

let shot = null;          // 焼き込み済みの写真（確認画面に出す）
let filePromise = null;   // 保存用の JPEG（できたら lastFile に入る）

function showThumbnail(source) {
  const t = document.createElement('canvas');
  const s = 160 / Math.max(source.width, source.height);
  t.width = Math.round(source.width * s); t.height = Math.round(source.height * s);
  t.getContext('2d').drawImage(source, 0, 0, t.width, t.height);
  $('thumb').style.backgroundImage = `url(${t.toDataURL('image/jpeg', 0.8)})`;
  $('thumb').classList.remove('empty');
}

// サムネイル → 確認画面 →「保存」→ 共有画面（「画像を保存」でカメラロールへ）。
// 以前は焼き込みが終わる前（撮ってから数秒）に押しても何も起きず、何度も押してやっと開く状態だった（2026-10-13）。
// 処理中に押されたら覚えておき、終わったら確認画面を開く（共有画面は「保存」を押したその場で開くので、
// Safari の「タップから時間がたつと開かせない」制限にかからない）。押されていなければサムネイルを弾ませて知らせる
let shareWanted = 0;   // 処理中にサムネイルが押された時刻（0＝押されていない）
let sharing = false;

/** サムネイルの横の案内（何を押せばいいか）。text が空なら消す */
function saveHint(text, waiting = false) {
  const h = $('saveHint');
  if (text) h.textContent = text;
  h.classList.toggle('on', !!text);
  h.classList.toggle('wait', waiting);
}

/** 確認画面：焼き込んだ写真を画面いっぱいに出す。ここで「保存」か「撮り直す」を選ぶ（2026-10-14。
 * 保存のときに一瞬だけ見せると、認識する前に消えて驚かせた） */
function openReview() {
  if (!shot) return;
  $('review').classList.add('on');
  // 焼き込んだ写真を、画面に収まる大きさで描く（JPEG を待たない）
  const c = $('reviewImage');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth * dpr, H = c.clientHeight * dpr;
  c.width = W; c.height = H;
  const s = Math.min(W / shot.width, H / shot.height);
  const w = shot.width * s, h = shot.height * s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(shot, (W - w) / 2, (H - h) / 2, w, h);
}
function closeReview() { $('review').classList.remove('on'); }

$('save').onclick = async () => {
  if (!lastFile) return;   // JPEG がまだ（ふつうは確認画面を見ている間にできている）
  // 「今撮った」と思わせるため、ここでシャッターの音を鳴らす（本人の希望。2026-10-14。演者が切れる）。
  // 共有画面は押した瞬間にしか開けないので、音を鳴らしたらすぐ続けて開く
  if (pageOptions.sound) shutterSound();
  if (await share()) closeReview();   // 共有画面を閉じただけ（保存しなかった）ときも確認画面は閉じる
};

// MARK: シャッターの音
// iPhone のカメラの音は Apple の音源なので使わず、短い雑音を2回重ねて「カ・シャ」に聞こえる音をその場で作る。
// マナーモードでも鳴らす（日本の iPhone のカメラはマナーモードでも鳴るので、そのほうが自然）。
// 音は画面に触れた操作の中でしか鳴らせないので、最初に触れたときに準備しておく
let audio = null;
function audioContext() {
  if (!audio) {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* 対応していないブラウザ */ }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audio = new AC();
  }
  if (audio.state === 'suspended') audio.resume();
  return audio;
}
document.addEventListener('pointerdown', () => audioContext(), { once: true, capture: true });

function shutterSound() {
  const ctx = audioContext();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.005;
  // 雑音を帯域で絞り、すぐ消える音にする（start 秒後に、dur 秒、中心の高さ freq、大きさ level）
  const burst = (start, dur, freq, level) => {
    const n = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0 + start);
    g.gain.exponentialRampToValueAtTime(level, t0 + start + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    src.connect(band).connect(g).connect(ctx.destination);
    src.start(t0 + start);
    src.stop(t0 + start + dur + 0.01);
  };
  burst(0, 0.035, 3800, 0.9);      // カ（シャッターが開く短い音）
  burst(0.07, 0.11, 2300, 0.75);   // シャ（閉じる音、少し長く低め）
}
$('retake').onclick = () => {
  // 撮り直す：この写真は使わない（サムネイルも消す）
  closeReview();
  lastFile = null;
  shot = null;
  $('save').disabled = true;
  saveHint('');
  $('thumb').classList.add('empty');
};

async function share() {
  if (!lastFile || sharing) return true;
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
  if (!shot) return;
  if (shareWanted) {
    // 処理中にサムネイルが押されていたら、終わったところで確認画面を開く（確認画面を使わない設定なら共有画面を試し、
    // Safari に止められたらサムネイルを弾ませる）
    shareWanted = 0;
    if (pageOptions.review) openReview();
    else saveNow().then((ok) => { if (!ok) bounce(); });
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

/** 確認画面を使わない設定のとき：シャッター音を鳴らし、JPEG ができるのを待ってすぐ共有画面を開く */
async function saveNow() {
  if (pageOptions.sound) shutterSound();
  if (!lastFile && filePromise) await filePromise;
  return share();
}

$('thumb').onclick = () => {
  if (shot) {
    if (pageOptions.review) openReview(); else saveNow();
  }
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
