import { DETECT_PEEK_BYTES } from '../limits';

export type ChatFormat = 'youtube' | 'twitch';

/** 先頭の固定バイト数だけ読んで形式を判定する（ReadLine 相当のことはしない：1行が長い形式があるため）。 */
export async function detectChatFormat(file: Blob): Promise<ChatFormat> {
  const head = await file.slice(0, DETECT_PEEK_BYTES).text();
  return head.includes('"replayChatItemAction"') ? 'youtube' : 'twitch';
}
