import { JsonArrayScanner } from './jsonArrayScanner';
import { getArray, getObject, getString, isObject } from './jsonValue';
import { readTextChunks } from './textReader';
import type { ChatMessage, ChatRun } from './types';

// 解釈の規則は PC版 TwitchChatParser.ParseComment と同じ。
// .NET の \b は Unicode の単語境界、JS は ASCII なので、境界を先読みで書き直している（計画5.2節）。
const SUBSCRIPTION_NOTICE = /^\S+\s+(?:subscribed|resubscribed|is gifting|gifted)(?![\p{L}\p{Mn}\p{Nd}\p{Pc}])/u;

export function parseTwitchComment(comment: unknown): ChatMessage | null {
  if (!isObject(comment)) return null;
  const offset = comment.content_offset_seconds;
  if (typeof offset !== 'number' || !(offset >= 0)) return null;
  const timeSeconds = Math.min(Math.floor(offset), 0xffffffff);

  let author = '';
  const commenter = getObject(comment, 'commenter');
  if (commenter) author = getString(commenter, 'display_name') ?? getString(commenter, 'name') ?? '';

  const message = getObject(comment, 'message');
  if (!message) return null;
  const body = getString(message, 'body') ?? '';
  if (SUBSCRIPTION_NOTICE.test(body)) return null;

  let isOwner = false;
  let isModerator = false;
  for (const badge of getArray(message, 'user_badges') ?? []) {
    const id = getString(badge, '_id');
    if (id === 'broadcaster') isOwner = true;
    else if (id === 'moderator') isModerator = true;
  }

  const runs: ChatRun[] = [];
  const fragments = getArray(message, 'fragments');
  if (fragments) {
    for (const fragment of fragments) {
      if (!isObject(fragment)) return null; // PC版は例外になり、そのコメントごと捨てる
      const text = typeof fragment.text === 'string' ? fragment.text : undefined;
      const emoticonId = getString(getObject(fragment, 'emoticon'), 'emoticon_id');
      if (emoticonId) {
        // URLは一字一句加工しない（sqliteのキーと完全一致が要る）
        runs.push({
          kind: 'emoji',
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${emoticonId}/default/dark/2.0`,
          alt: text ?? '',
        });
      } else if (text !== undefined && text.length > 0) {
        runs.push({ kind: 'text', text });
      }
    }
  } else if (body.length > 0) {
    runs.push({ kind: 'text', text: body });
  }
  if (runs.length === 0) return null;
  return { timeSeconds, author, isOwner, isModerator, runs };
}

export async function parseTwitchFile(
  file: Blob,
  onMessage: (message: ChatMessage) => void,
  sliceBytes?: number,
): Promise<void> {
  const scanner = new JsonArrayScanner('comments', (json) => {
    try {
      const message = parseTwitchComment(JSON.parse(json));
      if (message) onMessage(message);
    } catch {
      // 個別コメントの失敗は捨てて継続する
    }
  });
  for await (const text of readTextChunks(file, sliceBytes)) {
    scanner.push(text);
    if (scanner.finished) return; // comments 配列が閉じたら残りは読まない
  }
}
