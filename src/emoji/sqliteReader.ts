import { SQLITE_MAX_BLOB_BYTES, SQLITE_PAGE_CACHE_BYTES } from '../limits';
import { sniffImageType } from './imageType';

// 読み取り専用の最小のSQLiteリーダー。契約は
//   CREATE TABLE emoji_cache (url TEXT PRIMARY KEY, data BLOB NOT NULL)
// （PC版 EmojiCacheService.cs）。ファイル全体を読まず、必要なBツリーページだけを file.slice で読む（M3）。
// ファイル形式の一次情報: https://www.sqlite.org/fileformat2.html

export class OpenError {
  constructor(readonly reason: string) {}
}

export type EmojiDb = {
  /** 画像を返す。無い・5MiB超・壊れている場合は null。URLはUTF-8のバイト列で一字一句そのまま照合する。 */
  get(url: string): Promise<Blob | null>;
  close(): void;
  /** 読めるが注意が要る点（WALモード等）。 */
  readonly warnings: string[];
  /** テスト・診断用：スライス読み込みの回数と、ページキャッシュの保持バイト数。 */
  readonly stats: { sliceReads: number; cachedBytes: number };
};

const HEADER_MAGIC = 'SQLite format 3\0';
const OVERFLOW_WINDOW_PAGES = 64;
const MAX_DEPTH = 64;

const PAGE_INDEX_INTERIOR = 0x02;
const PAGE_TABLE_INTERIOR = 0x05;
const PAGE_INDEX_LEAF = 0x0a;
const PAGE_TABLE_LEAF = 0x0d;

class CorruptError extends Error {}

function u16(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

/** SQLiteの可変長整数（1〜9バイト）。 */
function readVarint(b: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  let p = pos;
  for (let i = 0; i < 8; i++) {
    if (p >= b.length) throw new CorruptError('varint');
    const byte = b[p++]!;
    value = value * 128 + (byte & 0x7f);
    if (byte < 0x80) return { value, next: p };
  }
  if (p >= b.length) throw new CorruptError('varint');
  return { value: value * 256 + b[p]!, next: p + 1 };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

type Column = { type: number; start: number; size: number };

function serialSize(type: number): number {
  if (type >= 12) return type % 2 === 0 ? (type - 12) / 2 : (type - 13) / 2;
  return [0, 1, 2, 3, 4, 6, 8, 8, 0, 0][type] ?? 0;
}

/** レコードのヘッダを読み、各列の型と本体内の位置を返す。ヘッダが buf に収まらなければ例外。 */
function parseRecordHeader(buf: Uint8Array): Column[] {
  const { value: headerSize, next } = readVarint(buf, 0);
  if (headerSize > buf.length) throw new CorruptError('record header');
  const columns: Column[] = [];
  let p = next;
  let bodyPos = headerSize;
  while (p < headerSize) {
    const t = readVarint(buf, p);
    p = t.next;
    const size = serialSize(t.value);
    columns.push({ type: t.value, start: bodyPos, size });
    bodyPos += size;
  }
  return columns;
}

function readInt(buf: Uint8Array, col: Column): number {
  if (col.type === 8) return 0;
  if (col.type === 9) return 1;
  if (col.type === 0 || col.type > 6) throw new CorruptError('int column');
  let value = buf[col.start]! & 0x80 ? -1 : 0;
  for (let i = 0; i < col.size; i++) value = value * 256 + buf[col.start + i]!;
  return value;
}

type Cell = {
  payloadSize: number;
  /** ページ内の、ページ内に置かれた先頭部分の位置と長さ */
  localPos: number;
  localLen: number;
  /** 最初のオーバーフローページ（無ければ 0） */
  overflow: number;
  rowid: number;
  leftChild: number;
};

class Reader {
  readonly warnings: string[] = [];
  readonly stats = { sliceReads: 0, cachedBytes: 0 };
  closed = false;

  private cache = new Map<number, Uint8Array>();
  private window: { first: number; bytes: Uint8Array } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  pageSize = 0;
  usable = 0;
  pageCount = 0;
  tableRoot = 0;
  indexRoot = 0;

  constructor(private readonly file: Blob) {}

  private async readSlice(start: number, end: number): Promise<Uint8Array> {
    this.stats.sliceReads++;
    return new Uint8Array(await this.file.slice(start, end).arrayBuffer());
  }

  async open(): Promise<void> {
    const head = await this.readSlice(0, 100);
    if (head.length < 100) throw new CorruptError('ファイルが小さすぎます');
    for (let i = 0; i < HEADER_MAGIC.length; i++) {
      if (head[i] !== HEADER_MAGIC.charCodeAt(i)) throw new CorruptError('SQLiteのファイルではありません');
    }
    const ps = u16(head, 16);
    this.pageSize = ps === 1 ? 65536 : ps;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) throw new CorruptError('ページサイズが不正です');
    this.usable = this.pageSize - head[20]!;
    if (this.usable < 480) throw new CorruptError('予約領域が不正です');
    const encoding = u32(head, 56);
    if (encoding > 1) throw new CorruptError('UTF-8以外のテキストエンコーディングには対応していません');
    if (head[18] === 2 || head[19] === 2) {
      this.warnings.push('WALモードのデータベースです。-wal ファイルの内容は読めないため、最新の状態が欠ける可能性があります');
    }
    this.pageCount = Math.floor(this.file.size / this.pageSize);
    await this.findRoots();
  }

  /** Bツリーのページ（葉・内部）。LRUで保持する。 */
  private async btreePage(n: number): Promise<Uint8Array> {
    const hit = this.cache.get(n);
    if (hit) {
      this.cache.delete(n);
      this.cache.set(n, hit);
      return hit;
    }
    if (n < 1 || n > this.pageCount) throw new CorruptError(`ページ番号が範囲外です: ${n}`);
    const page = await this.readSlice((n - 1) * this.pageSize, n * this.pageSize);
    if (page.length !== this.pageSize) throw new CorruptError('ページを読めません');
    this.cache.set(n, page);
    this.stats.cachedBytes += page.length;
    while (this.stats.cachedBytes > SQLITE_PAGE_CACHE_BYTES && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as number;
      this.stats.cachedBytes -= this.cache.get(oldest)!.length;
      this.cache.delete(oldest);
    }
    return page;
  }

  /** オーバーフローページ。キャッシュに入れず、連続する数十ページをまとめて読んで鎖をたどる。 */
  private async overflowPage(n: number): Promise<Uint8Array> {
    if (n < 1 || n > this.pageCount) throw new CorruptError(`オーバーフローページ番号が範囲外です: ${n}`);
    const w = this.window;
    if (w && n >= w.first && n < w.first + w.bytes.length / this.pageSize) {
      const o = (n - w.first) * this.pageSize;
      return w.bytes.subarray(o, o + this.pageSize);
    }
    const count = Math.min(OVERFLOW_WINDOW_PAGES, this.pageCount - n + 1);
    const bytes = await this.readSlice((n - 1) * this.pageSize, (n - 1 + count) * this.pageSize);
    if (bytes.length !== count * this.pageSize) throw new CorruptError('オーバーフローページを読めません');
    this.window = { first: n, bytes };
    return bytes.subarray(0, this.pageSize);
  }

  private headerOffset(n: number): number {
    return n === 1 ? 100 : 0;
  }

  private cellCount(page: Uint8Array, n: number): number {
    return u16(page, this.headerOffset(n) + 3);
  }

  private cellPos(page: Uint8Array, n: number, i: number, interior: boolean): number {
    const arrayStart = this.headerOffset(n) + (interior ? 12 : 8);
    return u16(page, arrayStart + i * 2);
  }

  private parseCell(page: Uint8Array, type: number, pos: number): Cell {
    const cell: Cell = { payloadSize: 0, localPos: 0, localLen: 0, overflow: 0, rowid: 0, leftChild: 0 };
    let p = pos;
    if (type === PAGE_TABLE_INTERIOR) {
      cell.leftChild = u32(page, p);
      cell.rowid = readVarint(page, p + 4).value;
      return cell;
    }
    if (type === PAGE_INDEX_INTERIOR) {
      cell.leftChild = u32(page, p);
      p += 4;
    }
    const size = readVarint(page, p);
    cell.payloadSize = size.value;
    p = size.next;
    if (type === PAGE_TABLE_LEAF) {
      const rowid = readVarint(page, p);
      cell.rowid = rowid.value;
      p = rowid.next;
    }
    const U = this.usable;
    const P = cell.payloadSize;
    const X = type === PAGE_TABLE_LEAF ? U - 35 : Math.floor(((U - 12) * 64) / 255) - 23;
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    let local = P;
    if (P > X) {
      const K = M + ((P - M) % (U - 4));
      local = K <= X ? K : M;
    }
    cell.localPos = p;
    cell.localLen = local;
    if (p + local > page.length) throw new CorruptError('セルがページをはみ出しています');
    if (local < P) {
      if (p + local + 4 > page.length) throw new CorruptError('セルがページをはみ出しています');
      cell.overflow = u32(page, p + local);
    }
    return cell;
  }

  /** ペイロードの [start, end) を、ページ内の部分とオーバーフローの鎖から組み立てる。 */
  private async readPayload(page: Uint8Array, cell: Cell, start: number, end: number): Promise<Uint8Array> {
    if (end > cell.payloadSize || start > end) throw new CorruptError('ペイロードの範囲が不正です');
    const out = new Uint8Array(end - start);
    const localEnd = Math.min(end, cell.localLen);
    if (start < localEnd) out.set(page.subarray(cell.localPos + start, cell.localPos + localEnd), 0);
    if (end <= cell.localLen) return out;
    const chunk = this.usable - 4;
    let offset = cell.localLen;
    let pageNo = cell.overflow;
    while (offset < end) {
      if (pageNo === 0) throw new CorruptError('オーバーフローの鎖が途切れています');
      const op = await this.overflowPage(pageNo);
      const from = Math.max(start, offset);
      const to = Math.min(end, offset + chunk);
      if (from < to) out.set(op.subarray(4 + (from - offset), 4 + (to - offset)), from - start);
      offset += chunk;
      pageNo = u32(op, 0);
    }
    return out;
  }

  private static isInterior(type: number): boolean {
    return type === PAGE_INDEX_INTERIOR || type === PAGE_TABLE_INTERIOR;
  }

  /** sqlite_master を全走査して、emoji_cache の表と自動インデックスのルートページを得る。 */
  private async findRoots(): Promise<void> {
    const visit = async (n: number, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) throw new CorruptError('Bツリーが深すぎます');
      const page = await this.btreePage(n);
      const h = this.headerOffset(n);
      const type = page[h]!;
      const count = this.cellCount(page, n);
      if (type === PAGE_TABLE_INTERIOR) {
        for (let i = 0; i < count; i++) await visit(this.parseCell(page, type, this.cellPos(page, n, i, true)).leftChild, depth + 1);
        await visit(u32(page, h + 8), depth + 1);
        return;
      }
      if (type !== PAGE_TABLE_LEAF) throw new CorruptError('sqlite_master のページ種別が不正です');
      for (let i = 0; i < count; i++) {
        const cell = this.parseCell(page, type, this.cellPos(page, n, i, false));
        const prefix = await this.readPayload(page, cell, 0, Math.min(cell.payloadSize, 512));
        const cols = parseRecordHeader(prefix);
        if (cols.length < 4) continue;
        const text = (c: Column): string => new TextDecoder().decode(prefix.subarray(c.start, c.start + c.size));
        const kind = text(cols[0]!);
        const name = text(cols[1]!);
        if (kind === 'table' && name === 'emoji_cache') this.tableRoot = readInt(prefix, cols[3]!);
        else if (kind === 'index' && name === 'sqlite_autoindex_emoji_cache_1') this.indexRoot = readInt(prefix, cols[3]!);
      }
    };
    await visit(1, 0);
    if (!this.tableRoot) throw new CorruptError('emoji_cache テーブルがありません');
    if (!this.indexRoot) throw new CorruptError('emoji_cache の主キーのインデックスがありません');
  }

  /** インデックスを二分探索し、url に一致する行の rowid を返す。内部ページのセルにも鍵本体がある。 */
  private async lookupRowid(key: Uint8Array): Promise<number | null> {
    let n = this.indexRoot;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const page = await this.btreePage(n);
      const h = this.headerOffset(n);
      const type = page[h]!;
      if (type !== PAGE_INDEX_INTERIOR && type !== PAGE_INDEX_LEAF) throw new CorruptError('インデックスのページ種別が不正です');
      const interior = Reader.isInterior(type);
      const count = this.cellCount(page, n);
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const cell = this.parseCell(page, type, this.cellPos(page, n, mid, interior));
        const payload = await this.readPayload(page, cell, 0, cell.payloadSize);
        const cols = parseRecordHeader(payload);
        if (cols.length < 2) throw new CorruptError('インデックスのレコードが不正です');
        const c0 = cols[0]!;
        const cmp = compareBytes(payload.subarray(c0.start, c0.start + c0.size), key);
        if (cmp === 0) return readInt(payload, cols[cols.length - 1]!);
        if (cmp < 0) lo = mid + 1;
        else hi = mid;
      }
      if (!interior) return null;
      n = lo < count ? this.parseCell(page, type, this.cellPos(page, n, lo, true)).leftChild : u32(page, h + 8);
    }
    throw new CorruptError('Bツリーが深すぎます');
  }

  /** テーブルを rowid で引き、data 列（2列目）のBLOBを返す。5MiB超は本体を読まずに null。 */
  private async lookupBlob(rowid: number): Promise<Uint8Array | null> {
    let n = this.tableRoot;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const page = await this.btreePage(n);
      const h = this.headerOffset(n);
      const type = page[h]!;
      const count = this.cellCount(page, n);
      if (type === PAGE_TABLE_INTERIOR) {
        let lo = 0;
        let hi = count;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const cell = this.parseCell(page, type, this.cellPos(page, n, mid, true));
          if (cell.rowid >= rowid) hi = mid;
          else lo = mid + 1;
        }
        n = lo < count ? this.parseCell(page, type, this.cellPos(page, n, lo, true)).leftChild : u32(page, h + 8);
        continue;
      }
      if (type !== PAGE_TABLE_LEAF) throw new CorruptError('テーブルのページ種別が不正です');
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const cell = this.parseCell(page, type, this.cellPos(page, n, mid, false));
        if (cell.rowid === rowid) return this.readBlobColumn(page, cell);
        if (cell.rowid < rowid) lo = mid + 1;
        else hi = mid;
      }
      return null;
    }
    throw new CorruptError('Bツリーが深すぎます');
  }

  private async readBlobColumn(page: Uint8Array, cell: Cell): Promise<Uint8Array | null> {
    const headerBytes = await this.readPayload(page, cell, 0, Math.min(cell.payloadSize, cell.localLen));
    const cols = parseRecordHeader(headerBytes);
    const data = cols[1];
    if (!data || data.type < 12) return null; // BLOB・TEXT以外
    if (data.size > SQLITE_MAX_BLOB_BYTES) return null; // 本体（オーバーフロー）を読まずに諦める
    if (data.start + data.size > cell.payloadSize) throw new CorruptError('BLOBの長さが不正です');
    return this.readPayload(page, cell, data.start, data.start + data.size);
  }

  get(url: string): Promise<Blob | null> {
    const run = async (): Promise<Blob | null> => {
      if (this.closed) return null;
      try {
        const rowid = await this.lookupRowid(new TextEncoder().encode(url));
        if (rowid === null) return null;
        const bytes = await this.lookupBlob(rowid);
        if (!bytes || bytes.length === 0) return null;
        const type = sniffImageType(bytes);
        return new Blob([bytes as BlobPart], type ? { type } : undefined);
      } catch (e) {
        if (e instanceof CorruptError) return null;
        throw e;
      }
    };
    // 同時に複数の巨大BLOBを読んでメモリが膨らまないよう、1件ずつ処理する
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.closed = true;
    this.cache.clear();
    this.window = null;
    this.stats.cachedBytes = 0;
  }
}

/** sqliteファイルを開く。非対応・破損は OpenError（理由つき）で返し、アプリは絵文字を代替表示にして続ける。 */
export async function openEmojiDb(file: Blob): Promise<EmojiDb | OpenError> {
  const reader = new Reader(file);
  try {
    await reader.open();
  } catch (e) {
    if (e instanceof CorruptError) return new OpenError(e.message);
    return new OpenError(e instanceof Error ? e.message : String(e));
  }
  return {
    get: (url) => reader.get(url),
    close: () => reader.close(),
    warnings: reader.warnings,
    stats: reader.stats,
  };
}
