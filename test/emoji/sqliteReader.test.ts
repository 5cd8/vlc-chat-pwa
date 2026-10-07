import { mkdtempSync, openAsBlob, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { SQLITE_PAGE_CACHE_BYTES } from '../../src/limits';
import { sniffImageType } from '../../src/emoji/imageType';
import { openEmojiDb, OpenError, type EmojiDb } from '../../src/emoji/sqliteReader';

const dir = mkdtempSync(join(tmpdir(), 'vlc-chat-pwa-sqlite-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function makeDb(setup: (db: DatabaseSync) => void): string {
  const path = join(dir, `db${counter++}.sqlite`);
  const db = new DatabaseSync(path);
  setup(db);
  db.close();
  return path;
}

const SCHEMA = 'CREATE TABLE emoji_cache(url TEXT PRIMARY KEY, data BLOB NOT NULL)';

// 先頭がPNGのマジックバイトで、残りは再現できる疑似乱数のバイト列
function blobFor(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].slice(0, Math.min(8, size)));
  return out;
}

function fill(db: DatabaseSync, rows: { url: string; data: Uint8Array }[]): void {
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const stmt = db.prepare('INSERT INTO emoji_cache(url, data) VALUES (?, ?)');
  for (const r of rows) stmt.run(r.url, r.data);
  db.exec('COMMIT');
}

async function open(path: string): Promise<EmojiDb> {
  const db = await openEmojiDb(await openAsBlob(path));
  if (db instanceof OpenError) throw new Error(`開けません: ${db.reason}`);
  return db;
}

async function bytesOf(blob: Blob | null): Promise<Uint8Array | null> {
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

function rowsFor(count: number, sizeOf: (i: number) => number, urlOf = (i: number) => `https://cdn.example/emoji/${i}.png`) {
  return Array.from({ length: count }, (_, i) => ({ url: urlOf(i), data: blobFor(i + 1, sizeOf(i)) }));
}

describe('openEmojiDb：node:sqlite で作ったDBと全件一致', () => {
  test.each([512, 4096, 65536])('ページサイズ %i：1万行以上（Bツリー2階層以上）・オーバーフローするBLOB', async (pageSize) => {
    const rows = rowsFor(12000, (i) => (i % 97 === 0 ? 5000 : 20 + (i % 300)));
    const path = makeDb((db) => {
      db.exec(`PRAGMA page_size = ${pageSize}`);
      fill(db, rows);
    });
    const db = await open(path);
    for (const r of rows) {
      const got = await bytesOf(await db.get(r.url));
      if (!got || !Buffer.from(got).equals(Buffer.from(r.data))) throw new Error(`不一致: ${r.url}`);
    }
    expect(await db.get('https://cdn.example/emoji/none.png')).toBeNull();
    expect(db.stats.cachedBytes).toBeLessThanOrEqual(SQLITE_PAGE_CACHE_BYTES);
    db.close();
    expect(await db.get(rows[0]!.url)).toBeNull();
  }, 60_000);

  test('日本語・長文・URLに使う記号を含むURL。URLはバイト列のまま照合する', async () => {
    const urls = [
      'https://yt3.ggpht.com/ytc/絵文字=s48-c-k-c0x00ffffff-no-rj',
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0',
      'あ',
      'ア',
      'a',
      'A',
      'a ',
      '',
      'https://x/' + 'ん'.repeat(200),
      'https://x/' + 'z'.repeat(3000),
    ];
    const rows = urls.map((url, i) => ({ url, data: blobFor(i + 1, 50) }));
    const path = makeDb((db) => {
      db.exec('PRAGMA page_size = 512');
      fill(db, rows);
    });
    const db = await open(path);
    for (const r of rows) expect(await bytesOf(await db.get(r.url)), r.url).toEqual(r.data);
    // URLを加工しない：大文字小文字・末尾の空白・正規化違いは別のキー
    expect(await db.get('https://STATIC-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0')).toBeNull();
    expect(await db.get('a  ')).toBeNull();
    expect(await db.get('あ゙')).toBeNull();
  });

  test('キー自体がオーバーフローする長大なURLが、内部ページのセルにも現れる', async () => {
    const rows = rowsFor(600, () => 30, (i) => `https://x/${String(i).padStart(4, '0')}/` + 'k'.repeat(400 + (i % 50)));
    const path = makeDb((db) => {
      db.exec('PRAGMA page_size = 512');
      fill(db, rows);
    });
    const db = await open(path);
    for (const r of rows) expect(await bytesOf(await db.get(r.url))).toEqual(r.data);
  });

  test('探すキーがインデックスの内部ページのセルにある（全件を引いて一致）', async () => {
    const rows = rowsFor(3000, () => 8);
    const path = makeDb((db) => {
      db.exec('PRAGMA page_size = 512');
      fill(db, rows);
    });
    const db = await open(path);
    const reads: number[] = [];
    for (const r of rows) {
      const before = db.stats.sliceReads;
      expect(await bytesOf(await db.get(r.url))).toEqual(r.data);
      reads.push(db.stats.sliceReads - before);
    }
    // 内部ページで見つかる行は、葉まで降りない分だけ読み込みが少ない
    expect(Math.min(...reads)).toBeLessThan(Math.max(...reads));
  });

  test('sqlite_master が1ページに収まらないほど多数の表・インデックスがある', async () => {
    const rows = rowsFor(50, () => 12);
    const path = makeDb((db) => {
      db.exec('PRAGMA page_size = 512');
      for (let i = 0; i < 300; i++) db.exec(`CREATE TABLE other${i}(a TEXT PRIMARY KEY, b, c)`);
      fill(db, rows);
      for (let i = 0; i < 100; i++) db.exec(`CREATE INDEX idx${i} ON other${i}(b)`);
    });
    const db = await open(path);
    for (const r of rows) expect(await bytesOf(await db.get(r.url))).toEqual(r.data);
  });

  test('空のテーブルは全て null', async () => {
    const path = makeDb((db) => db.exec(SCHEMA));
    const db = await open(path);
    expect(await db.get('x')).toBeNull();
  });

  test('画像の種類をマジックバイトで判定して Blob の type に付ける', async () => {
    const png = blobFor(1, 20);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
    const other = new Uint8Array([1, 2, 3, 4, 5]);
    const path = makeDb((db) =>
      fill(db, [
        { url: 'png', data: png },
        { url: 'gif', data: gif },
        { url: 'webp', data: webp },
        { url: 'jpeg', data: jpeg },
        { url: 'other', data: other },
      ]),
    );
    const db = await open(path);
    expect((await db.get('png'))!.type).toBe('image/png');
    expect((await db.get('gif'))!.type).toBe('image/gif');
    expect((await db.get('webp'))!.type).toBe('image/webp');
    expect((await db.get('jpeg'))!.type).toBe('image/jpeg');
    expect((await db.get('other'))!.type).toBe('');
    expect(sniffImageType(new Uint8Array(0))).toBe('');
  });
});

describe('大きなBLOB・ファイルサイズに依存しないこと', () => {
  test('5MiB超のBLOBは本体を読まずに null、直前（4MiB）は読める。オーバーフローはまとめて読む', async () => {
    const big = blobFor(1, 5 * 1024 * 1024 + 1);
    const mid = blobFor(2, 4 * 1024 * 1024);
    const path = makeDb((db) => fill(db, [{ url: 'big', data: big }, { url: 'mid', data: mid }, { url: 'small', data: blobFor(3, 10) }]));
    const db = await open(path);
    const before = db.stats.sliceReads;
    expect(await db.get('big')).toBeNull();
    expect(db.stats.sliceReads - before).toBeLessThan(10);
    const mark = db.stats.sliceReads;
    const got = await bytesOf(await db.get('mid'));
    const reads = db.stats.sliceReads - mark;
    expect(Buffer.from(got!).equals(Buffer.from(mid))).toBe(true); // toEqual は4M要素で非常に遅い
    expect(reads).toBeLessThan(40); // 1000ページ超を1ページずつ読まない
  });

  test('ページキャッシュは上限（8MiB）を超えない。保持バイトはファイルサイズに比例しない', async () => {
    // 1行が約1KB、4096B/ページで、表の葉だけで8MiBを超える
    const rows = rowsFor(12000, () => 1000);
    const path = makeDb((db) => fill(db, rows));
    const db = await open(path);
    let max = 0;
    for (const r of rows) {
      expect(await db.get(r.url)).not.toBeNull();
      max = Math.max(max, db.stats.cachedBytes);
    }
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(SQLITE_PAGE_CACHE_BYTES);
  }, 60_000);

  test('同時に呼んでも結果が混ざらない', async () => {
    const rows = rowsFor(500, (i) => 10 + i);
    const path = makeDb((db) => {
      db.exec('PRAGMA page_size = 512');
      fill(db, rows);
    });
    const db = await open(path);
    const got = await Promise.all(rows.map((r) => db.get(r.url)));
    for (let i = 0; i < rows.length; i++) expect(await bytesOf(got[i]!)).toEqual(rows[i]!.data);
  });
});

describe('OpenError（理由つき）', () => {
  test('UTF-16 のデータベースは非対応', async () => {
    const path = makeDb((db) => {
      db.exec("PRAGMA encoding = 'UTF-16le'");
      fill(db, [{ url: 'a', data: blobFor(1, 10) }]);
    });
    const r = await openEmojiDb(await openAsBlob(path));
    expect(r).toBeInstanceOf(OpenError);
    expect((r as OpenError).reason).toContain('UTF-8');
  });

  test('emoji_cache テーブルが無い', async () => {
    const path = makeDb((db) => db.exec('CREATE TABLE other(a TEXT PRIMARY KEY, b)'));
    const r = await openEmojiDb(await openAsBlob(path));
    expect(r).toBeInstanceOf(OpenError);
  });

  test('壊れたヘッダ・SQLiteではないファイル・小さすぎるファイル', async () => {
    const junk = join(dir, 'junk.sqlite');
    writeFileSync(junk, Buffer.alloc(4096, 7));
    expect(await openEmojiDb(await openAsBlob(junk))).toBeInstanceOf(OpenError);
    expect(await openEmojiDb(new Blob([new Uint8Array(10)]))).toBeInstanceOf(OpenError);
    expect(await openEmojiDb(new Blob([]))).toBeInstanceOf(OpenError);
  });

  test('ページを切り詰めたファイルは null を返して落ちない', async () => {
    const rows = rowsFor(2000, () => 20);
    const path = makeDb((db) => {
      db.exec('PRAGMA page_size = 512');
      fill(db, rows);
    });
    const whole = await openAsBlob(path);
    const cut = whole.slice(0, Math.floor(whole.size / 2));
    const r = await openEmojiDb(cut);
    if (r instanceof OpenError) return;
    for (const row of rows.slice(0, 2000)) await r.get(row.url);
  });

  test('WALモードのファイルは警告つきで読める', async () => {
    const rows = rowsFor(20, () => 10);
    const path = makeDb((db) => {
      db.exec('PRAGMA journal_mode = WAL');
      fill(db, rows);
    });
    const db = await open(path);
    expect(db.warnings.length).toBe(1);
    expect(db.warnings[0]).toContain('WAL');
  });

  test('ロールバックジャーナルのファイルには警告が出ない', async () => {
    const path = makeDb((db) => fill(db, rowsFor(5, () => 10)));
    expect((await open(path)).warnings).toEqual([]);
  });
});

// 予約領域が0でないDB（暗号化拡張など）は node:sqlite では作りにくいため未テスト（計画7節）。
