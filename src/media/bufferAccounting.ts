import { GAP_TOLERANCE_SECONDS } from '../limits';

// SourceBuffer の常駐バイト数・後方削除の終点・隙間判定の純粋関数と、断片の記録（5.3節 手順4〜6）。

export type Range = { start: number; end: number };
export type FragmentRecord = { start: number; end: number; bytes: number };

/** t を含む区間（先頭が t より後でも、差が tolerance 以内なら含むとみなす。再生開始時の buffered は先頭が0より少し後になる）。 */
export function containingRange(ranges: readonly Range[], t: number, tolerance = GAP_TOLERANCE_SECONDS): Range | null {
  for (const r of ranges) if (t >= r.start - tolerance && t <= r.end) return r;
  return null;
}

export function isInBuffer(ranges: readonly Range[], t: number, tolerance = GAP_TOLERANCE_SECONDS): boolean {
  return containingRange(ranges, t, tolerance) !== null;
}

/** 先読み秒数：t を含む区間の末尾 − t（最後の区間の末尾ではない）。区間が無ければ 0。 */
export function forwardSeconds(ranges: readonly Range[], t: number, tolerance = GAP_TOLERANCE_SECONDS): number {
  const r = containingRange(ranges, t, tolerance);
  return r ? Math.max(0, r.end - t) : 0;
}

function overlapsAny(record: FragmentRecord, ranges: readonly Range[]): boolean {
  return ranges.some((r) => record.start < r.end && record.end > r.start);
}

/**
 * 常駐バイト数：buffered と区間が重なる記録のバイト数の合計。足し引きの累計は持たず、append・remove・
 * UAの追い出し・シークのどの後でも同じ式で求め直す。区間の一部だけ残る記録も1個分として数える（過大側）。
 */
export function residentBytes(records: readonly FragmentRecord[], ranges: readonly Range[]): number {
  let sum = 0;
  for (const rec of records) if (overlapsAny(rec, ranges)) sum += rec.bytes;
  return sum;
}

/**
 * 後方削除の終点。記録したフラグメントの開始時刻のうち currentTime − backSeconds 以下で最大のもの。
 * （キーフレームでない位置を終点にすると、MSEは次のキーフレームまで削除範囲を延ばし、再生中のGOPまで消えるため。）
 * そのようなフラグメントが無い、または終点が bufferedStart 以下なら null。
 */
export function backRemovalEnd(
  records: readonly FragmentRecord[],
  currentTime: number,
  backSeconds: number,
  bufferedStart: number,
): number | null {
  const limit = currentTime - backSeconds;
  let best: number | null = null;
  for (const rec of records) if (rec.start <= limit && (best === null || rec.start > best)) best = rec.start;
  return best !== null && best > bufferedStart ? best : null;
}

/**
 * 隙間の判定：書き込み位置 − currentTime を含む区間の末尾 が許容誤差より大きいとき、区間の末尾から供給し直す。
 * 絶対値では比べない（区間の末尾が書き込み位置より先にあるのは隙間ではない）。区間が無ければ先読み0として扱う。
 */
export function findGap(
  ranges: readonly Range[],
  currentTime: number,
  writePosition: number,
  tolerance = GAP_TOLERANCE_SECONDS,
): { gapStart: number } | null {
  const r = containingRange(ranges, currentTime, tolerance);
  const rangeEnd = r ? r.end : currentTime;
  return writePosition - rangeEnd > tolerance ? { gapStart: rangeEnd } : null;
}

type OpenRecord = { position: number; timestamp: number };
type StoredRecord = FragmentRecord & { seq: number };

/**
 * 断片の記録（`onMoof` から作る）。唯一の情報源として、常駐バイト数・後方削除・書き込み位置を求める。
 * `Output` ごとに位置は0から数える（ローテーションで作り直すため）。
 */
export class FragmentLedger {
  private done: StoredRecord[] = [];
  private seq = 0;
  /** この供給（rewind 以降）で確定した記録だけを書き込み位置の計算に使う（以前の供給の高い位置を引きずらない） */
  private runSeq = 0;
  private open: OpenRecord | null = null;
  /** この Output で onMoof が来た位置と時刻 */
  private moofs: OpenRecord[] = [];
  /** この Output で受け取った（出力された）バイト数と、appendBuffer が終わったバイト数 */
  private emitted = 0;
  private appended = 0;
  /** まだ onMoof で確定していない（Output の内部に溜まっている）データの先頭の時刻 */
  private pendingStart: number | null = null;
  /** 供給の開始位置。これより前を書き込み位置にしない */
  private floor = 0;

  clear(startTime = 0): void {
    this.done = [];
    this.runSeq = this.seq;
    this.open = null;
    this.moofs = [];
    this.emitted = 0;
    this.appended = 0;
    this.pendingStart = null;
    this.floor = startTime;
  }

  /** 世代の切替で消さずに（隙間の再供給）新しい Output を始めるとき。 */
  beginOutput(startTime: number): void {
    this.open = null;
    this.moofs = [];
    this.emitted = 0;
    this.appended = 0;
    this.pendingStart = startTime;
    this.floor = Math.max(this.floor, startTime);
  }

  /** 隙間の再供給：組み立て中の断片を確定し、書き込み位置を time まで戻す（記録は、上書きされるまで常駐の計算に残す）。 */
  rewind(time: number): void {
    this.finishOutput(time);
    this.runSeq = this.seq;
    this.floor = time;
  }

  setPendingStart(time: number): void {
    this.pendingStart = time;
  }

  onMoof(position: number, timestamp: number): void {
    if (this.open) this.commit({ start: this.open.timestamp, end: timestamp, bytes: position - this.open.position });
    this.open = { position, timestamp };
    this.moofs.push(this.open);
  }

  onEmitted(bytes: number): void {
    this.emitted += bytes;
  }

  onAppended(bytes: number): void {
    this.appended += bytes;
  }

  /** Output を閉じた（finalize 済み）。最後の断片を確定する。endTime はその断片の終わりの時刻。 */
  finishOutput(endTime: number): void {
    if (this.open) this.commit({ start: this.open.timestamp, end: Math.max(endTime, this.open.timestamp), bytes: this.emitted - this.open.position });
    this.floor = Math.max(this.floor, endTime);
    this.open = null;
    this.moofs = [];
    this.emitted = 0;
    this.appended = 0;
    this.pendingStart = null;
  }

  /** 確定した記録に、いま組み立て中（追加済みの分だけ）の断片を加えたもの。 */
  records(): FragmentRecord[] {
    const done = this.done.map((r) => ({ start: r.start, end: r.end, bytes: r.bytes }));
    if (!this.open) return done;
    const end = this.pendingStart !== null && this.pendingStart > this.open.timestamp ? this.pendingStart : this.open.timestamp;
    return [...done, { start: this.open.timestamp, end, bytes: Math.max(0, this.appended - this.open.position) }];
  }

  /** 最大の断片の大きさ（バイト）。予算を半分にしたとき、入るかの判定に使う。 */
  maxFragmentBytes(): number {
    let max = 0;
    for (const r of this.records()) max = Math.max(max, r.bytes);
    return max;
  }

  /** currentTime を含む（再生中で追い出せない）断片の大きさ。 */
  bytesAt(time: number): number {
    for (const r of this.records()) if (time >= r.start && time < r.end) return r.bytes;
    return 0;
  }

  /**
   * 書き込み位置＝最後に updateend まで終えたフラグメントの終了時刻。
   * 出力の全部を追加し終えていれば、まだ出力されていない次の断片の先頭の時刻（ポンプが add したキーフレームの時刻）。
   */
  writePosition(): number {
    let pos = this.floor;
    for (const r of this.done) if (r.seq > this.runSeq) pos = Math.max(pos, r.end);
    if (!this.open) return pos;
    for (let i = 0; i < this.moofs.length; i++) {
      const m = this.moofs[i]!;
      const next = this.moofs[i + 1];
      const isLast = next === undefined;
      const complete = isLast ? this.appended >= this.emitted : this.appended >= next.position;
      if (!complete) return Math.max(pos, m.timestamp);
      if (isLast) return Math.max(pos, this.pendingStart ?? m.timestamp);
    }
    return pos;
  }

  /** 先頭側（バッファの前方から消えた分）の記録を捨てる。記録が増え続けないようにする。 */
  prune(ranges: readonly Range[], maxRecords = 1000): void {
    const first = ranges[0];
    if (first) this.done = this.done.filter((r) => r.end > first.start - GAP_TOLERANCE_SECONDS);
    if (this.done.length > maxRecords) this.done = this.done.slice(this.done.length - maxRecords);
  }

  private commit(record: FragmentRecord): void {
    // 新しい記録の区間に開始が含まれる古い記録（隙間の再供給でMSEが上書きしたもの）は捨てる
    this.done = this.done.filter((r) => !(r.start >= record.start - 1e-6 && r.start < record.end));
    this.done.push({ ...record, seq: ++this.seq });
    this.done.sort((a, b) => a.start - b.start);
  }
}
