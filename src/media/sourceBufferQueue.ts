// SourceBuffer の操作を直列に実行するキュー（5.3節 手順3）。MSE は updating 中の appendBuffer・remove で
// InvalidStateError を投げるので、1つの操作の updateend を待ってから次を実行する。
// DOM・MSE の型に直接依存せず、最小のインターフェースだけを受け取る（Node上のテストで偽物を渡せるように）。

export interface SourceBufferLike {
  appendBuffer(data: Uint8Array): void;
  remove(start: number, end: number): void;
  abort(): void;
  readonly updating: boolean;
  addEventListener(type: 'updateend' | 'error', handler: () => void): void;
  removeEventListener(type: 'updateend' | 'error', handler: () => void): void;
}

export interface MediaSourceLike {
  readonly readyState: 'closed' | 'open' | 'ended';
  endOfStream(): void;
}

/** キューが排他的に実行している間だけ使える、キューを通さない直接操作。 */
export type DirectIO = {
  append(data: Uint8Array): Promise<void>;
  remove(start: number, end: number): Promise<void>;
};

export class SourceBufferQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** discardPending() のたびに進める。進む前に積まれて未実行の操作は、実行せずに fallback で終える。 */
  private epoch = 0;
  private outstanding = 0;

  constructor(
    private readonly sb: SourceBufferLike,
    private readonly ms: MediaSourceLike,
  ) {}

  /** 未完了（実行中を含む）の操作の数 */
  get pending(): number {
    return this.outstanding;
  }

  /**
   * fn を排他的に実行する。discardPending() の前に積まれ、まだ始まっていなければ fn は実行せず fallback で解決する
   * （捨てる write 操作の Promise を必ず解決する。解決しないと、それを待つ旧 Output の add() が止まり、cancel() も終わらない）。
   */
  enqueue<T>(fn: (io: DirectIO) => Promise<T>, fallback: T): Promise<T> {
    const myEpoch = this.epoch;
    this.outstanding++;
    const run = async (): Promise<T> => {
      try {
        if (myEpoch !== this.epoch) return fallback;
        return await fn(this.io);
      } finally {
        this.outstanding--;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  append(data: Uint8Array): Promise<void> {
    return this.enqueue((io) => io.append(data), undefined);
  }

  remove(start: number, end: number): Promise<void> {
    return this.enqueue((io) => io.remove(start, end), undefined);
  }

  /** SourceBuffer のパーサーの状態をリセットする。readyState が open のときだけ（ended では InvalidStateError）。 */
  abort(): Promise<void> {
    return this.enqueue(async () => {
      if (this.ms.readyState === 'open') this.sb.abort();
    }, undefined);
  }

  endOfStream(): Promise<void> {
    return this.enqueue(async () => {
      if (this.ms.readyState === 'open') this.ms.endOfStream();
    }, undefined);
  }

  /** 未実行の操作を捨てる（実行中の操作は終わるまで待つ）。 */
  discardPending(): void {
    this.epoch++;
  }

  /** いま積まれている操作がすべて終わったとき解決する。 */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  private readonly io: DirectIO = {
    append: (data) => this.run(() => this.sb.appendBuffer(data)),
    remove: (start, end) => this.run(() => this.sb.remove(start, end)),
  };

  /** 操作を発行し、updateend まで待つ。同期的に投げられた例外（QuotaExceededError など）と error イベントは reject する。 */
  private run(issue: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let failed = false;
      const onError = (): void => {
        failed = true;
      };
      const onEnd = (): void => {
        this.sb.removeEventListener('updateend', onEnd);
        this.sb.removeEventListener('error', onError);
        if (failed) reject(new Error('SourceBuffer の操作に失敗しました'));
        else resolve();
      };
      this.sb.addEventListener('error', onError);
      this.sb.addEventListener('updateend', onEnd);
      try {
        issue();
      } catch (e) {
        this.sb.removeEventListener('updateend', onEnd);
        this.sb.removeEventListener('error', onError);
        reject(e);
      }
    });
  }
}
