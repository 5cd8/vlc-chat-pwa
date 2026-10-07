import type { Range } from '../../src/media/bufferAccounting';
import type {
  OutputEvents,
  OutputPort,
  Packet,
  TrackReader,
} from '../../src/media/packetPump';
import type { TrackKind } from '../../src/media/pumpPolicy';
import type { MediaSourceLike, SourceBufferLike } from '../../src/media/sourceBufferQueue';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs = 3000, what = '条件'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`時間切れ: ${what}`);
    await sleep(1);
  }
}

// ---- 偽の動画（パケット列） ----

export type FakePacket = Packet & { id: string; kind: TrackKind };

export type FakeMediaOptions = {
  duration: number;
  videoInterval?: number;
  gopSeconds?: number;
  audioInterval?: number | null;
  packetBytes?: number;
  /** 映像の最初のパケットの時刻（音声の遅れ・Bフレームで buffered の先頭が後ろにずれる状況の再現） */
  videoStart?: number;
  /** 映像パケットのバイト数を個別に決める */
  videoBytes?: (index: number) => number;
};

export class FakeMedia {
  readonly video: FakePacket[] = [];
  readonly audio: FakePacket[] = [];

  constructor(readonly options: FakeMediaOptions) {
    const vi = options.videoInterval ?? 0.5;
    const gop = options.gopSeconds ?? 2;
    const bytes = options.packetBytes ?? 1000;
    const start = options.videoStart ?? 0;
    const perGop = Math.max(1, Math.round(gop / vi));
    for (let i = 0; start + i * vi < options.duration; i++) {
      this.video.push({
        id: `v${i}`,
        kind: 'video',
        timestamp: start + i * vi,
        isKey: i % perGop === 0,
        byteLength: options.videoBytes ? options.videoBytes(i) : bytes,
        raw: null,
      });
    }
    if (options.audioInterval !== null) {
      const ai = options.audioInterval ?? 0.5;
      // 先頭は負の時刻（OpusのCodecDelayなど）から始める
      for (let i = -1; i * ai < options.duration; i++) {
        this.audio.push({ id: `a${i + 1}`, kind: 'audio', timestamp: i * ai, isKey: true, byteLength: 100, raw: null });
      }
    }
  }

  get hasAudio(): boolean {
    return this.audio.length > 0;
  }

  reader(list: FakePacket[]): TrackReader {
    const indexOf = (p: Packet): number => list.indexOf(p as FakePacket);
    const keyAtOrBefore = (t: number): Packet | null => {
      let found: Packet | null = null;
      for (const p of list) if (p.isKey && p.timestamp <= t) found = p;
      return found;
    };
    return {
      getFirst: async () => list[0] ?? null,
      getFirstKey: async () => list.find((p) => p.isKey) ?? null,
      getKeyAtOrBefore: async (t) => keyAtOrBefore(t),
      getAtOrBefore: async (t) => {
        let found: Packet | null = null;
        for (const p of list) if (p.timestamp <= t) found = p;
        return found;
      },
      getNext: async (p) => list[indexOf(p) + 1] ?? null,
      getNextKey: async (p) => list.slice(indexOf(p) + 1).find((q) => q.isKey) ?? null,
    };
  }
}

// ---- 偽の Output（Mediabunny の fragmented 出力の振る舞いを模す） ----

const HEADER_BYTES = 40;
const META_MAGIC = 0xab;

/** チャンクの先頭に、そのフラグメントの時間範囲を埋め込む（偽の SourceBuffer が読む）。 */
export function makeChunk(start: number, end: number, size: number): Uint8Array {
  const chunk = new Uint8Array(Math.max(size, 17));
  const view = new DataView(chunk.buffer);
  view.setFloat64(0, start);
  view.setFloat64(8, end);
  chunk[16] = META_MAGIC;
  return chunk;
}

export type OutputLog = {
  /** 各 Output に add されたパケットID（Output ごとに配列） */
  outputs: string[][];
  started: number;
  finalized: number;
  cancelled: number;
  moofs: { position: number; timestamp: number }[][];
};

export class FakeOutputFactory {
  readonly log: OutputLog = { outputs: [], started: 0, finalized: 0, cancelled: 0, moofs: [] };
  /** 1回の出力チャンクの大きさを変えたいときに、フラグメントのバイト数へ足す */
  extraFragmentBytes = 0;
  minFragmentSeconds = 2;
  /** finalize で書き出す最後の断片の終わり＝最後のパケットの時刻＋これ（通常は次のキーフレームの時刻） */
  tailPad = 0.5;
  /** add() の中で await する（一時停止などの再現用） */
  addDelay: () => Promise<void> = async () => undefined;

  make = (events: OutputEvents): OutputPort => {
    const log = this.log;
    const ids: string[] = [];
    const moofs: { position: number; timestamp: number }[] = [];
    log.outputs.push(ids);
    log.moofs.push(moofs);
    let position = 0;
    let fragment: FakePacket[] = [];
    let lastWrite: Promise<void> = Promise.resolve();
    let cancelled = false;
    const inflight = new Set<Promise<void>>();
    const factory = this;

    const write = (chunk: Uint8Array): void => {
      const p = lastWrite.then(() => events.write(chunk));
      lastWrite = p;
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
      position += chunk.length;
    };

    const flush = async (end: number): Promise<void> => {
      if (fragment.length === 0) return;
      const start = fragment.reduce((m, p) => Math.min(m, p.timestamp), Infinity);
      const bytes = fragment.reduce((a, p) => a + p.byteLength, 0) + HEADER_BYTES + factory.extraFragmentBytes;
      moofs.push({ position, timestamp: start });
      events.onMoof(position, start);
      fragment = [];
      // desiredSize <= 0 のとき writer.ready を待つ、を模す：直前の write が終わるまで add() は返らない
      await lastWrite;
      write(makeChunk(start, end, bytes));
    };

    return {
      start: async () => {
        log.started++;
        write(new Uint8Array(HEADER_BYTES)); // ftyp + moov
      },
      add: async (_kind, packet) => {
        if (cancelled) throw new Error('cancelled output');
        await factory.addDelay();
        const p = packet as FakePacket;
        if (p.kind === 'video' && p.isKey && fragment.length > 0) {
          const first = fragment[0]!.timestamp;
          if (p.timestamp - first >= factory.minFragmentSeconds) await flush(p.timestamp);
        }
        ids.push(p.id);
        fragment.push(p);
      },
      finalize: async () => {
        log.finalized++;
        const last = fragment[fragment.length - 1];
        await flush(last ? last.timestamp + factory.tailPad : 0);
        await lastWrite;
      },
      cancel: async () => {
        cancelled = true;
        log.cancelled++;
        // Mediabunny の cancel() は、出力先を閉じる際に未解決の write を待つ（解決しないと終わらない）
        await Promise.allSettled([...inflight]);
      },
    };
  };
}

// ---- 偽の SourceBuffer と MediaSource ----

type Segment = { start: number; end: number; bytes: number };

export class FakeSourceBuffer implements SourceBufferLike {
  updating = false;
  segments: Segment[] = [];
  appends: number[] = [];
  removes: [number, number][] = [];
  aborts = 0;
  /** 常駐がこれを超える追加は QuotaExceededError を投げる */
  capacity = Infinity;
  /** 次の n 回の追加を無条件に QuotaExceededError にする */
  failNext = 0;
  /** 追加が終わるまでの遅延 */
  delayMs = 0;
  private listeners = new Map<string, Set<() => void>>();
  private lastSegment: Segment | null = null;
  bufferedChangeListeners = new Set<() => void>();

  constructor(private readonly media: FakeMediaSource) {
    media.attach(this);
  }

  get bytes(): number {
    return this.segments.reduce((a, s) => a + s.bytes, 0);
  }

  ranges(): Range[] {
    const sorted = [...this.segments].sort((a, b) => a.start - b.start);
    const out: Range[] = [];
    for (const s of sorted) {
      const last = out[out.length - 1];
      if (last && s.start <= last.end + 1e-6) last.end = Math.max(last.end, s.end);
      else out.push({ start: s.start, end: s.end });
    }
    return out;
  }

  addEventListener(type: 'updateend' | 'error', handler: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(type: 'updateend' | 'error', handler: () => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  private fire(type: string): void {
    for (const h of [...(this.listeners.get(type) ?? [])]) h();
  }

  private finishLater(after?: () => void): void {
    this.updating = true;
    const done = (): void => {
      this.updating = false;
      after?.();
      this.fire('updateend');
    };
    if (this.delayMs > 0) setTimeout(done, this.delayMs);
    else queueMicrotask(done);
  }

  appendBuffer(data: Uint8Array): void {
    if (this.updating) throw new DOMException('updating', 'InvalidStateError');
    if (this.failNext > 0) {
      this.failNext--;
      throw new DOMException('quota', 'QuotaExceededError');
    }
    if (this.bytes + data.length > this.capacity) throw new DOMException('quota', 'QuotaExceededError');
    this.media.reopen();
    const meta = data.length >= 17 && data[16] === META_MAGIC;
    this.appends.push(data.length);
    this.finishLater(() => {
      if (meta) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const seg: Segment = { start: view.getFloat64(0), end: view.getFloat64(8), bytes: data.length };
        this.segments = this.segments.filter((s) => !(s.start >= seg.start - 1e-6 && s.end <= seg.end + 1e-6));
        this.segments.push(seg);
        this.lastSegment = seg;
      } else if (this.lastSegment) {
        this.lastSegment.bytes += data.length; // 分割された続き
      }
      this.fireBufferedChange();
    });
  }

  remove(start: number, end: number): void {
    if (this.updating) throw new DOMException('updating', 'InvalidStateError');
    this.media.reopen();
    this.removes.push([start, end]);
    this.finishLater(() => {
      this.segments = this.segments.filter((s) => !(s.start >= start && s.end <= end));
      this.fireBufferedChange();
    });
  }

  abort(): void {
    if (this.media.readyState !== 'open') throw new DOMException('not open', 'InvalidStateError');
    this.aborts++;
  }

  /** UAによる追い出し */
  evict(start: number, end: number): void {
    this.segments = this.segments.filter((s) => !(s.start >= start && s.end <= end));
    this.fireBufferedChange();
  }

  private fireBufferedChange(): void {
    for (const h of [...this.bufferedChangeListeners]) h();
  }
}

export class FakeMediaSource implements MediaSourceLike {
  readyState: 'closed' | 'open' | 'ended' = 'open';
  endOfStreamCalls = 0;
  streaming = true;
  private sb: FakeSourceBuffer | null = null;

  attach(sb: FakeSourceBuffer): void {
    this.sb = sb;
  }

  endOfStream(): void {
    if (this.readyState !== 'open') throw new DOMException('not open', 'InvalidStateError');
    this.endOfStreamCalls++;
    this.readyState = 'ended';
  }

  /** ended のとき append・remove は open に戻す（MSEの仕様） */
  reopen(): void {
    if (this.readyState === 'ended') this.readyState = 'open';
  }

  get buffer(): FakeSourceBuffer {
    return this.sb!;
  }
}
