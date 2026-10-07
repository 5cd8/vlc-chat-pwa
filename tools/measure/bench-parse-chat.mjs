// 本実装（src/chat/parseChat.ts）の速度・保持量の実測用。Node上の値で、iPhoneの代替ではない。
// 使い方: node --expose-gc tools/measure/bench-parse-chat.mjs <twitch|youtube> [件数]
// 合成データは tools/measure/ に作る（コミットしない）。
import { createServer } from 'vite';
import { createWriteStream, existsSync, openAsBlob } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const kind = process.argv[2] || 'twitch';
const N = Number(process.argv[3] || 220000);
const file = join(here, kind === 'twitch' ? `twitch_synth_${N}.json` : `youtube_synth_${N}.jsonl`);

const words = ['ｗｗｗ', 'いいね', 'ナイス', '草', 'うおおお', 'すごい', 'Kappa', 'LUL', '８８８８', 'おつかれ'];
function twitchComment(i) {
  const t = (i / N) * 36000 + Math.random();
  const text = Array.from({ length: 3 + (i % 5) }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(' ');
  const frags = [{ text, emoticon: null }];
  if (i % 4 === 0) frags.push({ text: 'Kappa', emoticon: { emoticon_id: '25' } });
  return JSON.stringify({
    _id: 'a1b2c3d4-' + i, created_at: '2026-01-01T00:00:00Z', content_offset_seconds: t,
    commenter: { display_name: 'ユーザー' + (i % 3000), _id: '' + (i % 3000), name: 'user' + (i % 3000), bio: null, logo: 'https://static-cdn.jtvnw.net/jtv_user_pictures/abcdef-profile_image-300x300.png' },
    message: { body: text, fragments: frags, is_action: false,
      user_badges: i % 10 === 0 ? [{ _id: 'moderator', version: '1' }] : [{ _id: 'subscriber', version: '3' }],
      user_color: '#FF4500', user_notice_params: { 'msg-id': null }, emoticons: [] },
  });
}
function youtubeLine(i) {
  const s = Math.floor((i / N) * 36000);
  const ts = `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return JSON.stringify({ replayChatItemAction: { actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: {
    timestampText: { simpleText: ts }, authorName: { simpleText: 'ユーザー' + (i % 3000) },
    message: { runs: [{ text: words[i % 10] + ' ' + words[(i * 3) % 10] }, ...(i % 4 === 0 ? [{ emoji: { isCustomEmoji: true, shortcuts: [':a:'], image: { thumbnails: [{ url: 'https://yt3.ggpht.com/e/' + (i % 50) }] } } }] : [])] },
    authorExternalChannelId: 'UC' + 'x'.repeat(22), id: 'ChwKGkNN' + i, authorPhoto: { thumbnails: [{ url: 'https://yt4.ggpht.com/' + 'a'.repeat(80), width: 32, height: 32 }] },
  } } } }], videoOffsetTimeMsec: String(s * 1000) } });
}

if (!existsSync(file)) {
  const out = createWriteStream(file);
  if (kind === 'twitch') {
    out.write('{"streamer":{"name":"x","id":1},"video":{"title":"y"},"comments":[');
    for (let i = 0; i < N; i += 2000) {
      const part = []; for (let j = i; j < Math.min(N, i + 2000); j++) part.push(twitchComment(j));
      out.write((i > 0 ? ',' : '') + part.join(','));
    }
    out.write(']}');
  } else {
    for (let i = 0; i < N; i += 2000) {
      const part = []; for (let j = i; j < Math.min(N, i + 2000); j++) part.push(youtubeLine(j));
      out.write(part.join('\n') + '\n');
    }
  }
  await new Promise((r) => out.end(r));
}

const server = await createServer({ root: join(here, '../..'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { parseChatFile } = await server.ssrLoadModule('/src/chat/parseChat.ts');
const blob = await openAsBlob(file);
global.gc?.();
const before = process.memoryUsage();
const t0 = performance.now();
const store = await parseChatFile(blob);
const ms = performance.now() - t0;
global.gc?.();
const after = process.memoryUsage();
const retained = store.times.byteLength + store.offsets.byteLength + store.records.reduce((a, c) => a + c.byteLength, 0);
console.log(JSON.stringify({
  kind, fileMB: +(blob.size / 1048576).toFixed(1), count: store.times.length, ms: Math.round(ms),
  MBps: +(blob.size / 1048576 / (ms / 1000)).toFixed(0), retainedMB: +(retained / 1048576).toFixed(1),
  emojiKinds: store.emojis.length, heapDeltaMB: +((after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers) / 1048576).toFixed(1),
}));
await server.close();
