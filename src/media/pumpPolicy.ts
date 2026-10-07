import { FORWARD_BUFFER_SECONDS, MIN_FORWARD_SECONDS, OUTPUT_ROTATION_SECONDS } from '../limits';

// ポンプの判定（書く順序・ローテーション・負の時刻・流量制御・総量待ち）の純粋関数。

export type TrackKind = 'video' | 'audio';

/** 小さい方のタイムスタンプを先に書く（同時刻は映像が先）。片方を先に流しきると、バッファが際限なく溜まる。 */
export function chooseTrack(
  video: { timestamp: number } | null,
  audio: { timestamp: number } | null,
): TrackKind | null {
  if (video && (!audio || video.timestamp <= audio.timestamp)) return 'video';
  return audio ? 'audio' : null;
}

/** 時刻が負のパケットは書かない（mediabunny が Output ごとに先頭の負の時刻ぶん音声をずらすため）。 */
export function isNegativeTime(timestamp: number): boolean {
  return timestamp < 0;
}

/** 次に書く映像パケットがキーフレームの位置で、Output を始めてからメディア時間で一定以上経っているとき。 */
export function shouldRotate(
  kind: TrackKind,
  isKey: boolean,
  timestamp: number,
  outputStartTime: number,
  rotationSeconds: number = OUTPUT_ROTATION_SECONDS,
): boolean {
  return kind === 'video' && isKey && timestamp - outputStartTime >= rotationSeconds;
}

export type FlowInput = {
  /** ManagedMediaSource.streaming（UAが供給を求めているか）。通常の MediaSource では常に true */
  streaming: boolean;
  forwardSeconds: number;
  /** キューに未完了の操作が残っている */
  queueBusy: boolean;
};

/** 次のパケットを読む前の流量制御。待つべきなら true。 */
export function shouldWaitForFlow(input: FlowInput): boolean {
  if (input.queueBusy) return true;
  if (input.forwardSeconds >= FORWARD_BUFFER_SECONDS) return true;
  // endstreaming でも、先読みが短いと再生が止まるので供給する
  return !input.streaming && input.forwardSeconds >= MIN_FORWARD_SECONDS;
}

export type BudgetInput = {
  resident: number;
  /** 次に出力される断片に入るパケットのバイト数 */
  pending: number;
  budget: number;
  /** currentTime を含む（再生中で追い出せない）断片の大きさ */
  playingFragmentBytes: number;
};

export type BudgetDecision = 'go' | 'wait' | 'unsatisfiable';

/**
 * 総量待ち。待っても解けないことが決定的に分かる場合（再生中の断片＋pending ＞ 予算。古い分を全部消しても入らない）
 * だけエラーにする。壁時計の時間切れは設けない（遅い再生速度・一時停止中は待ちが長くなるのが正常）。
 */
export function budgetDecision(input: BudgetInput): BudgetDecision {
  if (input.resident + input.pending <= input.budget) return 'go';
  if (input.playingFragmentBytes + input.pending > input.budget) return 'unsatisfiable';
  return 'wait';
}

/** チャンクを sliceBytes 以下に分ける（[start, end) の配列）。 */
export function splitSlices(total: number, sliceBytes: number): [number, number][] {
  const out: [number, number][] = [];
  for (let start = 0; start < total; start += sliceBytes) out.push([start, Math.min(total, start + sliceBytes)]);
  return out;
}
