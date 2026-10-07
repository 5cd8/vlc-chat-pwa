import { CHAT_CHUNK_BYTES, CHAT_INDEX_CHUNK_ITEMS } from '../limits';
import type { ChatMessage, ChatRun, ChatStore } from './types';

// レコード: recordLen(varint) / flags(1B: bit0=owner, bit1=moderator) / authorLen(varint)+author(UTF-8) /
//           runCount(varint) / 各run: kind(1B: 0=text, 1=emoji) + text は len(varint)+UTF-8、emoji は emojis の添字(varint)

const FLAG_OWNER = 1;
const FLAG_MODERATOR = 2;
const KIND_TEXT = 0;
const KIND_EMOJI = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ByteWriter {
  buf = new Uint8Array(1024);
  length = 0;

  reset(): void {
    this.length = 0;
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  byte(value: number): void {
    this.ensure(1);
    this.buf[this.length++] = value;
  }

  varint(value: number): void {
    this.ensure(8);
    let v = value;
    while (v >= 0x80) {
      this.buf[this.length++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.length++] = v;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
  }

  view(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

function varintSize(value: number): number {
  let size = 1;
  let v = value;
  while (v >= 0x80) {
    size++;
    v = Math.floor(v / 128);
  }
  return size;
}

function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  let p = pos;
  for (;;) {
    const b = buf[p++]!;
    value += (b & 0x7f) * scale;
    if (b < 0x80) break;
    scale *= 128;
  }
  return { value, next: p };
}

// 固定長チャンクの連結リストで伸ばす Uint32 列（倍々のコピーをしない）。
class GrowableUint32 {
  private chunks: Uint32Array[] = [];
  private used = 0;
  count = 0;

  constructor(private readonly chunkItems: number) {}

  push(value: number): void {
    if (this.chunks.length === 0 || this.used === this.chunkItems) {
      this.chunks.push(new Uint32Array(this.chunkItems));
      this.used = 0;
    }
    this.chunks[this.chunks.length - 1]![this.used++] = value;
    this.count++;
  }

  get(index: number): number {
    return this.chunks[Math.floor(index / this.chunkItems)]![index % this.chunkItems]!;
  }

  toArray(): Uint32Array {
    const out = new Uint32Array(this.count);
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      const start = i * this.chunkItems;
      const len = Math.min(this.chunkItems, this.count - start);
      out.set(chunk.subarray(0, len), start);
    }
    return out;
  }
}

// レコードをチャンクへ詰める。1件のレコードはチャンクをまたがせない。
class ChunkWriter {
  chunks: { buf: Uint8Array; used: number }[] = [];

  constructor(private readonly chunkBytes: number) {}

  /** body に recordLen を前置して1レコードとして追記し、位置を返す。チャンクに入らないほど大きければ -1。 */
  append(body: Uint8Array): number {
    const total = varintSize(body.length) + body.length;
    if (total > this.chunkBytes) return -1;
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.used + total > this.chunkBytes) {
      chunk = { buf: new Uint8Array(this.chunkBytes), used: 0 };
      this.chunks.push(chunk);
    }
    const offset = (this.chunks.length - 1) * this.chunkBytes + chunk.used;
    let v = body.length;
    while (v >= 0x80) {
      chunk.buf[chunk.used++] = (v % 128) | 0x80;
      v = Math.floor(v / 128);
    }
    chunk.buf[chunk.used++] = v;
    chunk.buf.set(body, chunk.used);
    chunk.used += body.length;
    return offset;
  }

  /** 最後のチャンクを使用長に切り詰めて返す（コピーは最後の1個だけ）。 */
  finish(): Uint8Array[] {
    return this.chunks.map((c, i) => (i === this.chunks.length - 1 ? c.buf.slice(0, c.used) : c.buf));
  }
}

export type ChatStoreBuilderOptions = { chunkBytes?: number; indexChunkItems?: number };

export class ChatStoreBuilder {
  private readonly chunkBytes: number;
  private readonly writer: ChunkWriter;
  private readonly times: GrowableUint32;
  private readonly offsets: GrowableUint32;
  private readonly emojiIds = new Map<string, number>();
  private readonly emojis: { url: string; alt: string }[] = [];
  private readonly scratch = new ByteWriter();
  private ascending = true;
  private lastTime = 0;

  constructor(options: ChatStoreBuilderOptions = {}) {
    this.chunkBytes = options.chunkBytes ?? CHAT_CHUNK_BYTES;
    const indexChunkItems = options.indexChunkItems ?? CHAT_INDEX_CHUNK_ITEMS;
    this.writer = new ChunkWriter(this.chunkBytes);
    this.times = new GrowableUint32(indexChunkItems);
    this.offsets = new GrowableUint32(indexChunkItems);
  }

  get count(): number {
    return this.times.count;
  }

  /** 1件を追加する。1レコードがチャンクに入らないほど大きければ捨てる（false）。 */
  add(message: ChatMessage): boolean {
    const w = this.scratch;
    w.reset();
    w.byte((message.isOwner ? FLAG_OWNER : 0) | (message.isModerator ? FLAG_MODERATOR : 0));
    const author = encoder.encode(message.author);
    w.varint(author.length);
    w.bytes(author);
    w.varint(message.runs.length);
    for (const run of message.runs) {
      if (run.kind === 'text') {
        const text = encoder.encode(run.text);
        w.byte(KIND_TEXT);
        w.varint(text.length);
        w.bytes(text);
      } else {
        w.byte(KIND_EMOJI);
        w.varint(this.emojiIndex(run.url, run.alt));
      }
    }
    const offset = this.writer.append(w.view());
    if (offset < 0) return false;
    const time = Math.min(Math.max(0, Math.floor(message.timeSeconds)), 0xffffffff);
    if (this.times.count > 0 && time < this.lastTime) this.ascending = false;
    this.lastTime = time;
    this.times.push(time);
    this.offsets.push(offset);
    return true;
  }

  private emojiIndex(url: string, alt: string): number {
    const key = `${url}\u0000${alt}`;
    let index = this.emojiIds.get(key);
    if (index === undefined) {
      index = this.emojis.length;
      this.emojis.push({ url, alt });
      this.emojiIds.set(key, index);
    }
    return index;
  }

  /** 完成した ChatStore を返す。昇順でなければ安定ソートして records を詰め直す。 */
  build(): ChatStore {
    const count = this.times.count;
    if (this.ascending) {
      return {
        times: this.times.toArray(),
        offsets: this.offsets.toArray(),
        records: this.writer.finish(),
        chunkBytes: this.chunkBytes,
        emojis: this.emojis,
      };
    }
    const times = this.times.toArray();
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    // 同じ秒は添字（ファイル順）で比べる。処理系の安定性に依存しない
    order.sort((a, b) => times[a]! - times[b]! || a - b);

    const oldChunks = this.writer.chunks;
    const writer = new ChunkWriter(this.chunkBytes);
    const sortedTimes = new Uint32Array(count);
    const sortedOffsets = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const src = order[i]!;
      const off = this.offsets.get(src);
      const chunk = oldChunks[Math.floor(off / this.chunkBytes)]!.buf;
      const { value: len, next } = readVarint(chunk, off % this.chunkBytes);
      sortedTimes[i] = times[src]!;
      sortedOffsets[i] = writer.append(chunk.subarray(next, next + len));
    }
    return {
      times: sortedTimes,
      offsets: sortedOffsets,
      records: writer.finish(),
      chunkBytes: this.chunkBytes,
      emojis: this.emojis,
    };
  }
}

/** index 番目のメッセージを復号する（表示中の最大200件だけが対象）。 */
export function decodeMessage(store: ChatStore, index: number): ChatMessage {
  const off = store.offsets[index]!;
  const chunk = store.records[Math.floor(off / store.chunkBytes)]!;
  let pos = readVarint(chunk, off % store.chunkBytes).next;
  const flags = chunk[pos++]!;
  const authorLen = readVarint(chunk, pos);
  pos = authorLen.next;
  const author = decoder.decode(chunk.subarray(pos, pos + authorLen.value));
  pos += authorLen.value;
  const runCount = readVarint(chunk, pos);
  pos = runCount.next;
  const runs: ChatRun[] = [];
  for (let i = 0; i < runCount.value; i++) {
    const kind = chunk[pos++]!;
    if (kind === KIND_TEXT) {
      const textLen = readVarint(chunk, pos);
      pos = textLen.next;
      runs.push({ kind: 'text', text: decoder.decode(chunk.subarray(pos, pos + textLen.value)) });
      pos += textLen.value;
    } else {
      const id = readVarint(chunk, pos);
      pos = id.next;
      const emoji = store.emojis[id.value]!;
      runs.push({ kind: 'emoji', url: emoji.url, alt: emoji.alt });
    }
  }
  return {
    timeSeconds: store.times[index]!,
    author,
    isOwner: (flags & FLAG_OWNER) !== 0,
    isModerator: (flags & FLAG_MODERATOR) !== 0,
    runs,
  };
}

/** Worker から渡すときの Transferable の一覧。 */
export function transferListOf(store: ChatStore): ArrayBuffer[] {
  return [
    store.times.buffer as ArrayBuffer,
    store.offsets.buffer as ArrayBuffer,
    ...store.records.map((r) => r.buffer as ArrayBuffer),
  ];
}
