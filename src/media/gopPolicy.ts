import { GOP_PROBE_TIMEOUT_MS, GOP_REFUSE_BYTES, GOP_WARN_BYTES } from '../limits';

// キーフレーム間隔（GOP）の長いMKVの扱い（計画4.4節）。F＝GOP長（秒）×ビットレート（バイト/秒）＝最大フラグメントの大きさ。

export type GopLevel = 'normal' | 'warn' | 'refuse';

export function classifyFragmentBytes(bytes: number): GopLevel {
  if (bytes > GOP_REFUSE_BYTES) return 'refuse';
  if (bytes > GOP_WARN_BYTES) return 'warn';
  return 'normal';
}

/** ビットレートは「ファイルサイズ÷再生時間」で見積もる。 */
export function estimateFragmentBytes(gopSeconds: number, fileBytes: number, durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 0;
  return gopSeconds * (fileBytes / durationSeconds);
}

export const GOP_WARN_MESSAGE = 'キーフレーム間隔が長く、メモリ使用量が大きくなる可能性があります';
export const GOP_REFUSE_MESSAGE =
  'キーフレーム間隔が長すぎるため、このアプリでは再生できません。PCで ffmpeg -i 入力.mkv -c copy -movflags +faststart 出力.mp4 により、再エンコードなしでMP4に変換してください';

export type KeyframeProber = {
  /** t 以前の最後のキーフレームの時刻（無ければ null）。パケット本体は読まない */
  keyAtOrBefore(t: number): Promise<number | null>;
  /** そのキーフレームの次のキーフレームの時刻（無ければ null） */
  nextKeyAfter(t: number): Promise<number | null>;
};

/**
 * 動画の長さの10%・50%・90%の位置で、隣り合うキーフレームの間隔を測り、最大値（秒）を返す。測れなければ null。
 * Matroskaの索引（Cues）が無いと、先頭からクラスタを読みながら走査するので、10%の測定だけを
 * timeoutMs 待ち、間に合わなければ残りの測定を省く（裏で走る読み込みは放置して結果は捨てる）。
 */
export async function probeMaxGopSeconds(
  prober: KeyframeProber,
  durationSeconds: number,
  timeoutMs: number = GOP_PROBE_TIMEOUT_MS,
): Promise<number | null> {
  const measure = async (at: number): Promise<number | null> => {
    const key = await prober.keyAtOrBefore(at);
    if (key === null) return null;
    const next = await prober.nextKeyAfter(key);
    return next === null ? null : next - key;
  };
  const fractions = [0.1, 0.5, 0.9];
  let max: number | null = null;
  const take = (gap: number | null): void => {
    if (gap !== null && (max === null || gap > max)) max = gap;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    measure(durationSeconds * fractions[0]!),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (first === 'timeout') return null; // Cuesが無いと見なし、再生中の pending の判定に任せる
  take(first);
  for (const f of fractions.slice(1)) take(await measure(durationSeconds * f));
  return max;
}
