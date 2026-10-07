// 本実装（src/emoji/sqliteReader.ts）の検索時間・読み込み回数の実測用（S4。Node上の値で、iPhoneの代替ではない）。
// 使い方: node tools/measure/bench-sqlite.mjs <sqliteファイル>            … 既存のDBの全URLを引く
//         node tools/measure/bench-sqlite.mjs --synth <出力先> <行数> <BLOBバイト>  … 合成DBを作ってから測る
import { createServer } from 'vite';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, openAsBlob } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let path = process.argv[2];
if (path === '--synth') {
  path = process.argv[3];
  const rows = Number(process.argv[4]);
  const size = Number(process.argv[5]);
  if (!existsSync(path)) {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE emoji_cache(url TEXT PRIMARY KEY, data BLOB NOT NULL)');
    db.exec('BEGIN');
    const stmt = db.prepare('INSERT INTO emoji_cache VALUES (?, ?)');
    const blob = new Uint8Array(size).fill(7);
    blob.set([0x89, 0x50, 0x4e, 0x47]);
    for (let i = 0; i < rows; i++) stmt.run(`https://static-cdn.jtvnw.net/emoticons/v2/${i}/default/dark/2.0`, blob);
    db.exec('COMMIT');
    db.close();
  }
}

const src = new DatabaseSync(path, { readOnly: true });
const urls = src.prepare('SELECT url FROM emoji_cache').all().map((r) => r.url);
src.close();

const server = await createServer({ root: join(here, '../..'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { openEmojiDb } = await server.ssrLoadModule('/src/emoji/sqliteReader.ts');
const file = await openAsBlob(path);
const t0 = performance.now();
const db = await openEmojiDb(file);
const tOpen = performance.now() - t0;
if (!db.get) { console.log('OpenError', db.reason); process.exit(1); }
let found = 0, skipped = 0, bytes = 0;
const t1 = performance.now();
for (const url of urls) {
  const b = await db.get(url);
  if (b) { found++; bytes += b.size; } else skipped++;
}
const ms = performance.now() - t1;
console.log(JSON.stringify({
  fileMB: +(file.size / 1048576).toFixed(1), rows: urls.length, openMs: +tOpen.toFixed(1), found, skippedOver5MiB: skipped,
  totalMs: Math.round(ms), perGetMs: +(ms / urls.length).toFixed(2), sliceReads: db.stats.sliceReads,
  readsPerGet: +(db.stats.sliceReads / urls.length).toFixed(2), cachedKiB: Math.round(db.stats.cachedBytes / 1024), returnedMB: +(bytes / 1048576).toFixed(1),
}));
await server.close();
