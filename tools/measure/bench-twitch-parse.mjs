// 5.2節のTwitch逐次スキャナ＋圧縮配列の試作（Nodeでの実測用。本実装ではない）
import { writeFileSync, existsSync, openAsBlob, createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';

const FILE = process.argv[2] || 'twitch_synth.json';
const N = Number(process.argv[3] || 220000);

// ---- 合成データ生成（TwitchDownloaderのChatRootに近い形。1件あたり約740B） ----
if (!existsSync(FILE)) {
  const out = createWriteStream(FILE);
  out.write('{"streamer":{"name":"x","id":1},"video":{"title":"y","start":0,"end":36000},"comments":[');
  const words = ['ｗｗｗ', 'いいね', 'ナイス', '草', 'うおおお', 'すごい', 'Kappa', 'LUL', '８８８８', 'おつかれ'];
  let buf = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * 36000 + Math.random();
    const text = Array.from({ length: 3 + (i % 5) }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ');
    const frags = [{ text, emoticon: null }];
    if (i % 4 === 0) frags.push({ text: 'Kappa', emoticon: { emoticon_id: '25' } });
    const c = {
      _id: 'a1b2c3d4-' + i, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      channel_id: '12345678', content_type: 'video', content_id: '87654321', content_offset_seconds: t,
      commenter: { display_name: 'ユーザー' + (i % 3000), _id: '' + (i % 3000), name: 'user' + (i % 3000), bio: null,
        created_at: '2020-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', logo: 'https://static-cdn.jtvnw.net/jtv_user_pictures/abcdef-profile_image-300x300.png' },
      message: { body: text, bits_spent: 0, fragments: frags, is_action: false,
        user_badges: i % 10 === 0 ? [{ _id: 'moderator', version: '1' }, { _id: 'subscriber', version: '12' }] : [{ _id: 'subscriber', version: '3' }],
        user_color: '#FF4500', user_notice_params: { 'msg-id': null }, emoticons: [] },
    };
    buf.push(JSON.stringify(c));
    if (buf.length === 2000) { out.write((i >= 1999 ? ',' : '') + buf.join(',')); buf = []; }
  }
  if (buf.length) out.write(',' + buf.join(','));
  out.write(']}');
  await new Promise((r) => out.end(r));
}

// ---- 逐次スキャナ＋圧縮配列（1MiBずつ file.slice で読む） ----
const blob = await openAsBlob(FILE);
const CHUNK = 1024 * 1024;
const dec = new TextDecoder('utf-8');
const enc = new TextEncoder();

// レコード用チャンク（4MiB）
const RC = 4 * 1024 * 1024;
let recChunks = [], cur = new Uint8Array(RC), curUsed = 0;
let times = [], emojis = new Map(), count = 0, retainedBytes = 0;
function pushRecord(bytes) {
  if (curUsed + bytes.length > RC) { recChunks.push({ buf: cur, used: curUsed }); cur = new Uint8Array(RC); curUsed = 0; }
  cur.set(bytes, curUsed); curUsed += bytes.length;
}
const scratch = new Uint8Array(1 << 16);
function encodeComment(c) {
  const msg = c.message; if (!msg) return;
  // 圧縮レコード：flags / author / runs（textのみUTF-8、絵文字は添字）
  const parts = []; let flags = 0;
  for (const b of msg.user_badges || []) { if (b._id === 'broadcaster') flags |= 1; else if (b._id === 'moderator') flags |= 2; }
  const author = (c.commenter && (c.commenter.display_name || c.commenter.name)) || '';
  const frags = msg.fragments || [];
  let s = String.fromCharCode(flags) + author + '\u0001';
  for (const f of frags) {
    if (f.emoticon && f.emoticon.emoticon_id) { let id = emojis.get(f.emoticon.emoticon_id); if (id === undefined) { id = emojis.size; emojis.set(f.emoticon.emoticon_id, id); } s += '\u0002' + id + '\u0001'; }
    else if (f.text) s += f.text + '\u0001';
  }
  const bytes = enc.encode(s);
  pushRecord(bytes);
  times.push(Math.floor(c.content_offset_seconds)); count++;
}

const t0 = performance.now();
let pos = 0, depth = 0, inStr = false, esc = false, started = false, objStart = -1;
let carry = new Uint8Array(0);   // チャンク境界をまたぐ1件ぶん
let seenComments = false, inCommentsArray = false, bytesRead = 0;
let scanOnly = process.argv[4] === 'scan';
// 超単純な状態機械：最初の "comments":[ を見つけたら、深さ(配列内)==1 の { } を1件ずつ切り出す
let sawKey = '';  // 直近の "comments" 検出用バッファ
const keyPat = enc.encode('"comments":[');
let keyMatch = 0;
let arrDepth = 0;   // comments配列に入った後の深さ（配列自身=1、要素オブジェクト=2…）
let partStart = -1;
const parts = [];
for (let off = 0; off < blob.size; off += CHUNK) {
  const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
  bytesRead += buf.length;
  let from = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (!inCommentsArray) {
      // ルート直下を読み飛ばしつつ "comments":[ を探す（文字列状態は簡略化：本試作では深さ判定を省略）
      if (b === keyPat[keyMatch]) { keyMatch++; if (keyMatch === keyPat.length) { inCommentsArray = true; arrDepth = 1; from = i + 1; } } else keyMatch = (b === keyPat[0]) ? 1 : 0;
      continue;
    }
    if (inStr) { if (esc) esc = false; else if (b === 0x5c) esc = true; else if (b === 0x22) inStr = false; continue; }
    if (b === 0x22) { inStr = true; continue; }
    if (b === 0x7b) { if (arrDepth === 1) { partStart = i; parts.length = 0; } arrDepth++; }
    else if (b === 0x7d) {
      arrDepth--;
      if (arrDepth === 1) {
        // 1件の終わり
        let objBytes;
        if (parts.length) { parts.push(buf.subarray(0, i + 1)); let tot = 0; for (const p of parts) tot += p.length; objBytes = new Uint8Array(tot); let o = 0; for (const p of parts) { objBytes.set(p, o); o += p.length; } parts.length = 0; }
        else objBytes = buf.subarray(partStart, i + 1);
        if (!scanOnly) encodeComment(JSON.parse(dec.decode(objBytes)));
        else count++;
        partStart = -1;
      }
    } else if (b === 0x5d && arrDepth === 1) { inCommentsArray = false; }
  }
  if (partStart >= 0 && arrDepth > 1) { parts.push(buf.slice(partStart)); partStart = 0; }
}
recChunks.push({ buf: cur, used: curUsed });
const dt = performance.now() - t0;
const usedBytes = recChunks.reduce((a, c) => a + c.used, 0);
global.gc && global.gc();
const m = process.memoryUsage();
console.log(JSON.stringify({
  fileMB: (blob.size / 1048576).toFixed(0), comments: count, mode: scanOnly ? 'scan-only' : 'scan+JSON.parse+encode',
  ms: Math.round(dt), MBps: (blob.size / 1048576 / (dt / 1000)).toFixed(0),
  retained: { recordsMB: (usedBytes / 1048576).toFixed(1), timesMB: ((count * 4) / 1048576).toFixed(1), heapUsedMB: (m.heapUsed / 1048576).toFixed(0), arrayBuffersMB: (m.arrayBuffers / 1048576).toFixed(0) },
  emojiKinds: emojis.size,
}));
