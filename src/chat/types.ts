export type ChatRun = { kind: 'text'; text: string } | { kind: 'emoji'; url: string; alt: string };

// 論理モデル（PC版 Models/ChatMessage.cs に対応）。保持するときは ChatStore の圧縮形式にする。
export type ChatMessage = {
  timeSeconds: number;
  author: string;
  isOwner: boolean;
  isModerator: boolean;
  runs: ChatRun[];
};

// 保持形式。times・offsets・records は Transferable で渡す。
export type ChatStore = {
  /** 昇順の整数秒（切り捨て）。長さ＝件数。 */
  times: Uint32Array;
  /** 各レコードの位置＝チャンク番号×chunkBytes＋チャンク内の位置。 */
  offsets: Uint32Array;
  /** chunkBytes ごとのチャンク（最後だけ使用長に切り詰め済み）。 */
  records: Uint8Array[];
  chunkBytes: number;
  /** 絵文字の (url, alt) の重複排除テーブル。 */
  emojis: { url: string; alt: string }[];
};
