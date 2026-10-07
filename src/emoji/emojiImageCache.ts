import { EMOJI_CACHE_MAX_BYTES, EMOJI_CACHE_MAX_ITEMS } from '../limits';

export type EmojiSource = { get(url: string): Promise<Blob | null> };

export type EmojiImageCacheOptions = {
  maxItems?: number;
  maxBytes?: number;
  /** テストで差し替える。既定は URL.createObjectURL / revokeObjectURL。 */
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
};

/**
 * URL→オブジェクトURLのLRU（PC版 EmojiImageCache に対応）。件数と合計バイトの両方で上限を持ち、
 * 追い出し時に revokeObjectURL する。同じURLの同時の読み込みは1つに合流させる。
 */
export class EmojiImageCache {
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly create: (blob: Blob) => string;
  private readonly revoke: (url: string) => void;
  private readonly entries = new Map<string, { objectUrl: string; size: number }>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private totalBytes = 0;
  private source: EmojiSource | null = null;
  /** clear() のたびに進める。読み込み中に clear された結果は捨てる。 */
  private epoch = 0;

  constructor(options: EmojiImageCacheOptions = {}) {
    this.maxItems = options.maxItems ?? EMOJI_CACHE_MAX_ITEMS;
    this.maxBytes = options.maxBytes ?? EMOJI_CACHE_MAX_BYTES;
    this.create = options.createObjectUrl ?? ((b) => URL.createObjectURL(b));
    this.revoke = options.revokeObjectUrl ?? ((u) => URL.revokeObjectURL(u));
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** 絵文字の読み出し元（sqlite）。null なら常に「無し」を返す。 */
  setSource(source: EmojiSource | null): void {
    this.source = source;
  }

  /** 表示用のオブジェクトURLを返す。無い・読めないときは null（呼び出し側が alt テキストにする）。 */
  getOrLoad(url: string): Promise<string | null> {
    if (!url) return Promise.resolve(null);
    const hit = this.entries.get(url);
    if (hit) {
      this.entries.delete(url);
      this.entries.set(url, hit);
      return Promise.resolve(hit.objectUrl);
    }
    const pending = this.inFlight.get(url);
    if (pending) return pending;
    const load: Promise<string | null> = this.load(url).finally(() => {
      // clear() の後に始まった新しい読み込みを消さない
      if (this.inFlight.get(url) === load) this.inFlight.delete(url);
    });
    this.inFlight.set(url, load);
    return load;
  }

  /** すべての URL を revoke して空にする（sqlite が選び直される可能性があるため）。 */
  clear(): void {
    this.epoch++;
    for (const entry of this.entries.values()) this.revoke(entry.objectUrl);
    this.entries.clear();
    this.inFlight.clear();
    this.totalBytes = 0;
  }

  private async load(url: string): Promise<string | null> {
    const source = this.source;
    if (!source) return null;
    const epoch = this.epoch;
    let blob: Blob | null;
    try {
      blob = await source.get(url);
    } catch {
      return null;
    }
    if (!blob || epoch !== this.epoch) return null;
    const objectUrl = this.create(blob);
    this.entries.set(url, { objectUrl, size: blob.size });
    this.totalBytes += blob.size;
    this.evict();
    return objectUrl;
  }

  private evict(): void {
    while (this.entries.size > this.maxItems || (this.totalBytes > this.maxBytes && this.entries.size > 1)) {
      const oldest = this.entries.entries().next().value as [string, { objectUrl: string; size: number }];
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].size;
      this.revoke(oldest[1].objectUrl);
    }
  }
}
