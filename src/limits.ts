// メモリ・時間の上限をここに集める。単位（秒・バイト・件数・ミリ秒）を必ず明記する。
// 根拠は design-docs-for-ai の実装計画 4節（実機 iPhone 16 の実測を含む）。

const KiB = 1024;
const MiB = 1024 * KiB;

// ---- MKV再生（ManagedMediaSource） ----

/** 1回の appendBuffer に渡す最大バイト数。実機（iOS Safari 26）で約4MiBが上限、8MiB以上は空のバッファでも QuotaExceededError。 */
export const APPEND_SLICE_BYTES = 4 * MiB;

/** SourceBuffer に常駐させる総量の予算（バイト）。初期値。実機の総容量が約100MiBで、今のGOPと次のGOPの両方が収まる必要がある。QuotaExceededError のときは実行時に半分にする。 */
export const SOURCEBUFFER_BUDGET_BYTES = 80 * MiB;

/** 最大フラグメントF（GOP長×ビットレート）がこれを超えたら警告（バイト）。実機で最後まで再生できたのが約24MiB。 */
export const GOP_WARN_BYTES = 24 * MiB;

/** Fがこれを超えたら再生を断る（バイト）。2F ≦ 予算80MiB から決めた仮の値。 */
export const GOP_REFUSE_BYTES = 40 * MiB;

/** 先読みの上限（秒）。 */
export const FORWARD_BUFFER_SECONDS = 30;

/** endstreaming 中でも、先読みがこれ未満なら供給を続ける（秒）。 */
export const MIN_FORWARD_SECONDS = 2;

/** 再生位置より後ろに残す秒数。 */
export const BACK_BUFFER_SECONDS = 15;

/** 常駐が予算の半分を超えたときに後ろへ残す秒数。 */
export const BACK_BUFFER_PRESSURED_SECONDS = 1;

/** buffered の端のずれの許容（秒）。映像と音声の積集合で端がわずかにずれる。 */
export const GAP_TOLERANCE_SECONDS = 0.5;

/** 再生前のGOP判定で、先頭の1回の調査を待つ時間（ミリ秒）。 */
export const GOP_PROBE_TIMEOUT_MS = 2000;

/** バッファ外へのシークを、最後の seeking からこの時間待って1回にまとめる（ミリ秒）。 */
export const SEEK_DEBOUNCE_MS = 250;

/** Output（フラグメントMP4の書き出し）を作り直す間隔（メディア時間の秒）。Output は確定したフラグメントのメタデータを保持し続けるため。 */
export const OUTPUT_ROTATION_SECONDS = 300;

/** Mediabunny の minimumFragmentDuration（単位は秒。ミリ秒と取り違えると約33分ぶんを溜める）。 */
export const MIN_FRAGMENT_SECONDS = 2;

/** QuotaExceededError の再試行の最大回数（チャンクごと）。 */
export const QUOTA_RETRY_MAX = 3;

/** BlobSource のキャッシュ上限（バイト）。 */
export const MKV_SOURCE_CACHE_BYTES = 4 * MiB;

// ---- チャット ----

/** チャット欄に残す最大件数（PC版の MaxItems と同じ）。 */
export const CHAT_MAX_ITEMS = 200;

/** ChatStore.records の1チャンクの大きさ（バイト）。 */
export const CHAT_CHUNK_BYTES = 4 * MiB;

/** times・offsets を伸ばす固定長チャンクの件数。 */
export const CHAT_INDEX_CHUNK_ITEMS = 64 * KiB;

/** ファイルを読むときの1回の大きさ（バイト）。blob.stream() は使わない。 */
export const FILE_READ_SLICE_BYTES = 1 * MiB;

/** 形式判定で先頭から読むバイト数。 */
export const DETECT_PEEK_BYTES = 4096;

// ---- 絵文字 ----

/** 絵文字画像のLRUの最大件数（PC版 EmojiImageCache と同じ）。 */
export const EMOJI_CACHE_MAX_ITEMS = 1000;

/** 絵文字画像のLRUの合計バイト数の上限。 */
export const EMOJI_CACHE_MAX_BYTES = 32 * MiB;

/** sqliteリーダーのBツリーページキャッシュの合計上限（バイト）。オーバーフローページは含めない。 */
export const SQLITE_PAGE_CACHE_BYTES = 8 * MiB;

/** これを超えるBLOBは読まない（PC版 MaxBlobSizeBytes と同じ、バイト）。 */
export const SQLITE_MAX_BLOB_BYTES = 5 * MiB;
