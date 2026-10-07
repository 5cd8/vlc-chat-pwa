import {
  BACK_BUFFER_PRESSURED_SECONDS,
  BACK_BUFFER_SECONDS,
  APPEND_SLICE_BYTES,
  GOP_REFUSE_BYTES,
  GOP_WARN_BYTES,
  QUOTA_RETRY_MAX,
  SEEK_DEBOUNCE_MS,
  SOURCEBUFFER_BUDGET_BYTES,
} from '../limits';
import {
  backRemovalEnd,
  findGap,
  forwardSeconds,
  FragmentLedger,
  isInBuffer,
  residentBytes,
  type Range,
} from './bufferAccounting';
import { GOP_REFUSE_MESSAGE, GOP_WARN_MESSAGE } from './gopPolicy';
import {
  budgetDecision,
  chooseTrack,
  isNegativeTime,
  shouldRotate,
  shouldWaitForFlow,
  splitSlices,
  type TrackKind,
} from './pumpPolicy';
import type { MediaSourceLike, SourceBufferQueue } from './sourceBufferQueue';

// MKVのパケットを読み、フラグメントMP4に詰め替えて SourceBuffer へ供給するポンプ（5.3節 手順2〜8）。
// DOM・MSE・Mediabunny の型に依存せず、下のポートだけを受け取る。実物は mkvPlayer.ts が包んで渡す。

export type Packet = { timestamp: number; isKey: boolean; byteLength: number; raw: unknown };

/** 1トラックのパケット読み出し（EncodedPacketSink を包む）。 */
export interface TrackReader {
  getFirst(): Promise<Packet | null>;
  getFirstKey(): Promise<Packet | null>;
  /** t 以前（開始時刻が t 以下）の最後のキーフレーム */
  getKeyAtOrBefore(t: number): Promise<Packet | null>;
  /** 開始時刻が t 以下の最後のパケット */
  getAtOrBefore(t: number): Promise<Packet | null>;
  getNext(p: Packet): Promise<Packet | null>;
  getNextKey(p: Packet): Promise<Packet | null>;
}

export type OutputEvents = {
  /** フラグメントが確定した（position は、その Output の先頭からのバイト位置） */
  onMoof(position: number, timestamp: number): void;
  /** 出力の追記。resolve しないことで、背圧が add() まで伝わる */
  write(chunk: Uint8Array): Promise<void>;
};

/** Mediabunny の Output を包む。 */
export interface OutputPort {
  start(): Promise<void>;
  /** first は、そのトラックの最初の add（decoderConfig を付ける） */
  add(kind: TrackKind, packet: Packet, first: boolean): Promise<void>;
  /** 最後のフラグメントを書き出す */
  finalize(): Promise<void>;
  cancel(): Promise<void>;
}

export type OutputFactory = (events: OutputEvents) => OutputPort;

export interface PlayerClock {
  currentTime(): number;
}

export interface BufferedView {
  ranges(): Range[];
  /** ManagedMediaSource.streaming。通常の MediaSource では常に true */
  streaming(): boolean;
}

export type PumpCallbacks = {
  onFatal(message: string): void;
  onWarning(message: string): void;
};

export type PumpDeps = {
  video: TrackReader;
  audio: TrackReader | null;
  makeOutput: OutputFactory;
  queue: SourceBufferQueue;
  media: MediaSourceLike;
  clock: PlayerClock;
  buffered: BufferedView;
  durationSeconds: number;
  callbacks: PumpCallbacks;
};

class Run {
  output: OutputPort | null = null;
  firstVideo = true;
  firstAudio = true;
  outputStart = 0;
  /** 次に出力される断片に入るパケットのバイト数 */
  pending = 0;
  /** 直前のキーフレーム以降に add した分 */
  bytesSinceKey = 0;
  lastKeyTime = 0;
  moofSeen = false;

  constructor(
    readonly gen: number,
    readonly signal: AbortSignal,
    /** 最初の供給、またはバッファを空にしての供給（再供給ではない） */
    readonly startsFresh: boolean,
  ) {}
}

function isQuotaError(e: unknown): boolean {
  return e instanceof Error && e.name === 'QuotaExceededError';
}

export class PacketPump {
  private gen = 0;
  private abort = new AbortController();
  private run: Run | null = null;
  private readonly ledger = new FragmentLedger();
  /** 実行時の総量予算。QuotaExceededError のたびに半分にする */
  private budget = SOURCEBUFFER_BUDGET_BYTES;
  private ended = false;
  private switching = false;
  private disposed = false;
  private failed = false;
  private warned = false;
  private removing = false;
  // 診断表示用の計数（暫定。PR作成前に、診断表示とあわせて撤去する）
  private appendedTotal = 0;
  private rotations = 0;
  private quotaHits = 0;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  /** この再生で最初に供給したキーフレームの時刻。これより前には（供給していないので）データが無い */
  private feedStart = 0;
  private lastRefeed = { gapStart: -1, at: 0 };
  private readonly waiters = new Set<() => void>();

  constructor(private readonly deps: PumpDeps) {}

  /** 供給を始める。 */
  start(startTime = 0): void {
    void this.begin(startTime, false, true);
  }

  /** 再生位置・SourceBuffer・UAの状態が変わった（timeupdate・updateend・startstreaming 等）。 */
  notify(): void {
    if (this.disposed) return;
    this.maybeRemoveBack();
    this.wake();
  }

  /** `seeking` イベント。バッファ内なら何もせず、範囲外なら合流させて1回だけ世代を切り替える。 */
  onSeeking(): void {
    if (this.disposed || this.failed) return;
    this.clearSeekTimer();
    if (isInBuffer(this.deps.buffered.ranges(), this.position())) return;
    this.seekTimer = setTimeout(() => {
      this.seekTimer = null;
      const t = this.deps.clock.currentTime();
      if (!isInBuffer(this.deps.buffered.ranges(), this.position())) void this.begin(t, true, false);
    }, SEEK_DEBOUNCE_MS);
  }

  /** `bufferedchange`（UAによる追い出しを含む）。隙間ができていれば、その位置から供給し直す。 */
  onBufferedChange(): void {
    if (this.disposed || this.failed || this.switching || this.seekTimer !== null) return;
    const gap = findGap(this.deps.buffered.ranges(), this.position(), this.ledger.writePosition());
    if (gap && !this.isRepeatedRefeed(gap.gapStart)) {
      this.lastRefeed = { gapStart: gap.gapStart, at: Date.now() };
      void this.begin(gap.gapStart, false, false);
    } else this.wake();
  }

  /** 診断表示用（暫定）。保持秒数・常駐バイト数・先読み・追加済みバイト数・回転とQuotaの回数。 */
  diagnostics(): string {
    const MB = 1024 * 1024;
    const ranges = this.deps.buffered.ranges();
    const t = this.deps.clock.currentTime();
    const resident = residentBytes(this.ledger.records(), ranges);
    const held = ranges.reduce((a, r) => a + (r.end - r.start), 0);
    return [
      `t=${t.toFixed(1)}s gen=${this.gen}${this.switching ? ' (切替中)' : ''}${this.ended ? ' ended' : ''}${this.failed ? ' FAILED' : ''}`,
      `buffered=${ranges.map((r) => `${r.start.toFixed(1)}-${r.end.toFixed(1)}`).join(',') || '-'} (${held.toFixed(1)}s) forward=${forwardSeconds(ranges, t).toFixed(1)}s`,
      `resident=${(resident / MB).toFixed(1)}MB budget=${(this.budget / MB).toFixed(0)}MB appended=${(this.appendedTotal / MB).toFixed(1)}MB`,
      `fragments=${this.ledger.records().length} maxFrag=${(this.ledger.maxFragmentBytes() / MB).toFixed(1)}MB rotations=${this.rotations} quota=${this.quotaHits} queue=${this.deps.queue.pending}`,
    ].join('\n');
  }

  /** 再生位置。供給を始めたキーフレームより前には、データが無いのが正常なので、そこへ丸める。 */
  private position(): number {
    return Math.max(this.deps.clock.currentTime(), this.feedStart);
  }

  /** 同じ位置からの再供給を短時間に繰り返さない（追い出しと供給が堂々巡りになるのを防ぐ）。 */
  private isRepeatedRefeed(gapStart: number): boolean {
    return Math.abs(gapStart - this.lastRefeed.gapStart) < 0.01 && Date.now() - this.lastRefeed.at < 2000;
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    this.abort.abort();
    this.clearSeekTimer();
    this.deps.queue.discardPending();
    const output = this.run?.output;
    this.run = null;
    output?.cancel().catch(() => undefined);
    this.wake();
  }

  // ---- 世代の切替（シークと隙間の再供給で共通：手順6） ----

  private async begin(startTime: number, clear: boolean, initial: boolean): Promise<void> {
    if (this.disposed || this.failed) return;
    const gen = ++this.gen;
    this.abort.abort();
    const abort = (this.abort = new AbortController());
    this.clearSeekTimer();
    this.switching = true;
    this.wake();
    const old = this.run;
    this.run = null;
    // 旧 Output の cancel() は待たない（完了は後で拾う）。未実行の操作は捨てるが、捨てる write の Promise は必ず解決する
    old?.output?.cancel().catch(() => undefined);
    this.deps.queue.discardPending();
    await this.deps.queue.idle();
    if (gen !== this.gen) return;
    try {
      // moof だけ追加して mdat を捨てた状態のまま新しい初期化セグメントを追加すると append error になるため、パーサーをリセットする
      await this.deps.queue.abort();
      // SourceBuffer を空にする。新しい Output の start() より前に積む（ftyp は start() の時点で出力されるため）
      if (clear && !initial) await this.deps.queue.remove(0, Infinity);
    } catch (e) {
      if (gen === this.gen) this.fail(`SourceBuffer を準備できませんでした（${describe(e)}）`);
      return;
    }
    if (gen !== this.gen) return;
    if (clear) this.ledger.clear(startTime);
    else this.ledger.rewind(startTime); // 旧 Output で組み立て中だった断片の記録を確定し、書き込み位置を再供給の開始位置へ戻す
    this.ended = false;
    this.switching = false;
    const run = new Run(gen, abort.signal, clear || initial);
    this.run = run;
    this.runGeneration(run, startTime).catch((e: unknown) => {
      if (!this.stale(run)) this.fail(describe(e));
    });
  }

  private stale(run: Run): boolean {
    return this.disposed || run.gen !== this.gen;
  }

  private clearSeekTimer(): void {
    if (this.seekTimer !== null) clearTimeout(this.seekTimer);
    this.seekTimer = null;
  }

  private fail(message: string): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.gen++;
    this.abort.abort();
    this.clearSeekTimer();
    this.deps.queue.discardPending();
    this.run?.output?.cancel().catch(() => undefined);
    this.run = null;
    this.wake();
    this.deps.callbacks.onFatal(message);
  }

  // ---- 供給（手順2） ----

  private async runGeneration(run: Run, startTime: number): Promise<void> {
    const { video, audio } = this.deps;
    // 開始位置：映像は startTime 以前のキーフレームから（無ければ最初のキーフレーム）。時刻0以上の最初のキーフレームから始める
    let vp = (await video.getKeyAtOrBefore(startTime)) ?? (await video.getFirstKey());
    while (vp && isNegativeTime(vp.timestamp)) vp = await video.getNextKey(vp);
    if (this.stale(run)) return;
    if (!vp) return this.fail('映像のキーフレームが見つかりません');
    if (run.startsFresh) this.feedStart = vp.timestamp;
    // 音声はキーフレームの時刻以下の最後のパケットから。無ければ最初のパケットから（始まるまでは映像だけを書く）
    let ap: Packet | null = null;
    if (audio) ap = (await audio.getAtOrBefore(vp.timestamp)) ?? (await audio.getFirst());
    if (this.stale(run)) return;

    await this.startOutput(run, vp.timestamp);

    for (;;) {
      if (this.stale(run)) return;
      if (audio && ap && isNegativeTime(ap.timestamp)) {
        ap = await audio.getNext(ap);
        continue;
      }
      const kind = chooseTrack(vp, ap);
      if (!kind) break;
      const pkt = (kind === 'video' ? vp : ap)!;
      const isKeyframe = kind === 'video' && pkt.isKey;
      if (!(await this.beforeAdd(run, pkt, isKeyframe, kind))) return;

      if (isKeyframe) {
        run.bytesSinceKey = 0;
        run.lastKeyTime = pkt.timestamp;
      }
      const first = kind === 'video' ? run.firstVideo : run.firstAudio;
      if (kind === 'video') run.firstVideo = false;
      else run.firstAudio = false;
      await run.output!.add(kind, pkt, first);
      if (this.stale(run)) return;
      run.pending += pkt.byteLength;
      run.bytesSinceKey += pkt.byteLength;
      if (run.moofSeen) {
        // 断片が出力された。次の断片に入るのは、直前のキーフレーム以降に add した分
        run.moofSeen = false;
        run.pending = run.bytesSinceKey;
        this.ledger.setPendingStart(run.lastKeyTime);
      }
      if (kind === 'video') vp = await video.getNext(pkt);
      else ap = await audio!.getNext(pkt);
    }

    // 終了：総量待ち → finalize（最後のフラグメントはここで書き出される）→ endOfStream
    if (!(await this.waitForBudget(run))) return;
    await run.output!.finalize();
    if (this.stale(run)) return;
    this.ledger.finishOutput(this.deps.durationSeconds);
    await this.deps.queue.endOfStream();
    if (this.stale(run)) return;
    this.ended = true; // endOfStream の後は後方削除をしない（remove() は ended を open に戻し、再生の終わりが止まる）
  }

  private async startOutput(run: Run, startTime: number): Promise<void> {
    run.firstVideo = true;
    run.firstAudio = true;
    run.outputStart = startTime;
    run.pending = 0;
    run.bytesSinceKey = 0;
    run.lastKeyTime = startTime;
    run.moofSeen = false;
    this.ledger.beginOutput(startTime);
    run.output = this.deps.makeOutput({
      onMoof: (position, timestamp) => {
        if (this.stale(run)) return;
        this.ledger.onMoof(position, timestamp);
        run.moofSeen = true;
      },
      write: (chunk) => this.handleChunk(run, chunk),
    });
    await run.output.start();
  }

  /** Output のローテーション：確定したフラグメントのメタデータを finalize まで保持し続けるので、一定時間ごとに作り直す。 */
  private async rotate(run: Run, nextKeyTime: number): Promise<void> {
    await run.output!.finalize(); // 旧 Output の全チャンクが updateend まで済む。待たずに新しい Output を始めると初期化セグメントが追い越す
    if (this.stale(run)) return;
    this.ledger.finishOutput(nextKeyTime);
    this.rotations++;
    await this.startOutput(run, nextKeyTime);
  }

  // ---- 流量制御（手順4） ----

  private async beforeAdd(run: Run, pkt: Packet, isKeyframe: boolean, kind: TrackKind): Promise<boolean> {
    for (;;) {
      if (this.stale(run)) return false;
      this.maybeRemoveBack();
      const forward = forwardSeconds(this.deps.buffered.ranges(), this.deps.clock.currentTime());
      const wait = shouldWaitForFlow({
        streaming: this.deps.buffered.streaming(),
        forwardSeconds: forward,
        queueBusy: this.deps.queue.pending > 0,
      });
      if (!wait) break;
      await this.waitWake(run);
    }
    // パケットを add する前に毎回判定する（キーフレームのときだけだと、事前の判定が外れた巨大な断片を Output に溜めてから止めることになる）
    const pendingAfter = run.pending + pkt.byteLength;
    if (pendingAfter > GOP_REFUSE_BYTES) {
      this.fail(GOP_REFUSE_MESSAGE);
      return false;
    }
    if (pendingAfter > GOP_WARN_BYTES && !this.warned) {
      this.warned = true;
      this.deps.callbacks.onWarning(GOP_WARN_MESSAGE);
    }
    if (isKeyframe) {
      if (!(await this.waitForBudget(run))) return false;
      if (shouldRotate(kind, isKeyframe, pkt.timestamp, run.outputStart)) {
        await this.rotate(run, pkt.timestamp);
        if (this.stale(run)) return false;
      }
    }
    return !this.stale(run);
  }

  /** 「常駐バイト数＋pending ≦ 総量予算」になるまで待つ。待っても解けないことが決定的なときだけエラー。 */
  private async waitForBudget(run: Run): Promise<boolean> {
    for (;;) {
      if (this.stale(run)) return false;
      const ranges = this.deps.buffered.ranges();
      this.ledger.prune(ranges);
      const decision = budgetDecision({
        resident: residentBytes(this.ledger.records(), ranges),
        pending: run.pending,
        budget: this.budget,
        playingFragmentBytes: this.ledger.bytesAt(this.deps.clock.currentTime()),
      });
      if (decision === 'go') return true;
      if (decision === 'unsatisfiable') {
        this.fail(GOP_REFUSE_MESSAGE);
        return false;
      }
      this.maybeRemoveBack();
      await this.waitWake(run);
    }
  }

  // ---- 出力の受け取りと追加（手順2・3） ----

  private async handleChunk(run: Run, chunk: Uint8Array): Promise<void> {
    if (this.stale(run)) return;
    this.ledger.onEmitted(chunk.length);
    // 1回の appendBuffer は約4MiB以下（実機の上限）。メディアセグメントを複数の appendBuffer に分けるのはMSEの仕様で許される
    for (const [start, end] of splitSlices(chunk.length, APPEND_SLICE_BYTES)) {
      const ok = await this.appendSlice(run, chunk.subarray(start, end));
      if (!ok || this.stale(run)) return;
      this.ledger.onAppended(end - start);
      this.appendedTotal += end - start;
    }
    this.wake();
  }

  private async appendSlice(run: Run, data: Uint8Array): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      const result = await this.deps.queue.enqueue<'ok' | 'quota'>(async (io) => {
        try {
          await io.append(data);
          return 'ok';
        } catch (e) {
          if (!isQuotaError(e)) throw e;
          // キューに積むと自分の後ろに並んで互いに待つので、この操作の中で後方を直接削除して再試行する
          const start = this.deps.buffered.ranges()[0]?.start;
          const end = this.removalEnd();
          if (start !== undefined && end !== null) await io.remove(start, end);
          try {
            await io.append(data);
            return 'ok';
          } catch (e2) {
            if (isQuotaError(e2)) return 'quota';
            throw e2;
          }
        }
      }, 'ok');
      if (this.stale(run)) return false;
      if (result === 'ok') return true;
      this.quotaHits++;
      if (attempt + 1 >= QUOTA_RETRY_MAX) {
        this.fail('メモリ不足のため、これ以上バッファに追加できません');
        return false;
      }
      // 総量予算を半分にして（以後このファイルの再生中はずっと半分）、後方の削除で空きができてから再試行する
      this.budget = Math.floor(this.budget / 2);
      if (this.ledger.maxFragmentBytes() > this.budget / 2) {
        this.fail('この端末では、このMKVのキーフレーム間隔では再生できません');
        return false;
      }
      if (!(await this.waitForRoom(run, data.length))) return false;
    }
  }

  /** 「常駐バイト数＋次のチャンク ≦ 予算」になるまで、後方の削除を促して待つ。 */
  private async waitForRoom(run: Run, extra: number): Promise<boolean> {
    for (;;) {
      if (this.stale(run)) return false;
      const ranges = this.deps.buffered.ranges();
      if (residentBytes(this.ledger.records(), ranges) + extra <= this.budget) return true;
      this.maybeRemoveBack();
      await this.waitWake(run);
    }
  }

  // ---- 後方の削除（手順5） ----

  private removalEnd(): number | null {
    const ranges = this.deps.buffered.ranges();
    const first = ranges[0];
    if (!first) return null;
    const resident = residentBytes(this.ledger.records(), ranges);
    // 常駐が予算の半分を超えているときは、再生中のGOPの手前まで詰める
    const back = resident > this.budget / 2 ? BACK_BUFFER_PRESSURED_SECONDS : BACK_BUFFER_SECONDS;
    return backRemovalEnd(this.ledger.records(), this.deps.clock.currentTime(), back, first.start);
  }

  private maybeRemoveBack(): void {
    if (this.ended || this.switching || this.removing || this.disposed || this.failed) return;
    const first = this.deps.buffered.ranges()[0];
    const end = this.removalEnd();
    if (!first || end === null) return;
    this.removing = true;
    this.deps.queue
      .remove(first.start, end)
      .catch(() => undefined)
      .finally(() => {
        this.removing = false;
        this.wake();
      });
  }

  // ---- 待機 ----

  private waitWake(run: Run): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        run.signal.removeEventListener('abort', done);
        resolve();
      };
      // 取りこぼしても止まらないように、低頻度の保険を付ける（待っている間だけ）
      const timer = setTimeout(done, 1000);
      this.waiters.add(done);
      run.signal.addEventListener('abort', done);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
