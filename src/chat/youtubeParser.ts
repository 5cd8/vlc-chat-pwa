import { getArray, getObject, getString, isObject } from './jsonValue';
import { LineSplitter, readTextChunks } from './textReader';
import type { ChatMessage, ChatRun } from './types';

// 解釈の規則は PC版 ChatParser.ParseJsonLinesAsync と同じ（差は計画5.2節に記載）。

/** "MM:SS" または "H:MM:SS"（各部分は1桁以上の数字だけ）を秒にする。それ以外は null。 */
export function parseTimestamp(text: string): number | null {
  if (text.includes('-')) return null;
  const parts = text.split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  return parts.length === 2 ? n[0]! * 60 + n[1]! : n[0]! * 3600 + n[1]! * 60 + n[2]!;
}

function badgeFlags(renderer: unknown): { isOwner: boolean; isModerator: boolean } {
  let isOwner = false;
  let isModerator = false;
  for (const badge of getArray(renderer, 'authorBadges') ?? []) {
    const b = getObject(badge, 'liveChatAuthorBadgeRenderer');
    if (!b) continue;
    const iconType = getString(getObject(b, 'icon'), 'iconType')?.toUpperCase();
    const tooltip = getString(b, 'tooltip')?.toLowerCase();
    if (iconType === 'OWNER' || tooltip?.includes('owner')) isOwner = true;
    else if (iconType === 'MODERATOR' || tooltip?.includes('moderator')) isModerator = true;
  }
  return { isOwner, isModerator };
}

function parseRuns(renderer: unknown): ChatRun[] {
  const runs: ChatRun[] = [];
  const list = getArray(getObject(renderer, 'message'), 'runs');
  if (!list) return runs;
  let pending = '';
  const flush = (): void => {
    if (pending.length > 0) runs.push({ kind: 'text', text: pending });
    pending = '';
  };
  for (const run of list) {
    if (!isObject(run)) continue;
    if ('text' in run) {
      pending += typeof run.text === 'string' ? run.text : '';
    } else if ('emoji' in run) {
      flush();
      const emoji = run.emoji;
      if (!isObject(emoji)) continue;
      const thumbnails = getArray(getObject(emoji, 'image'), 'thumbnails');
      const imageUrl = getString(thumbnails?.[0], 'url');
      const isCustom = typeof emoji.isCustomEmoji === 'boolean' ? emoji.isCustomEmoji : imageUrl !== undefined;
      const emojiId = getString(emoji, 'emojiId');
      if (isCustom && imageUrl !== undefined) {
        // URLは一字一句加工しない（sqliteのキーと完全一致が要る）
        const shortcut = getArray(emoji, 'shortcuts')?.[0];
        const label = getString(
          getObject(getObject(getObject(emoji, 'image'), 'accessibility'), 'accessibilityData'),
          'label',
        );
        const alt = (typeof shortcut === 'string' ? shortcut : label) || emojiId || '';
        runs.push({ kind: 'emoji', url: imageUrl, alt });
      } else if (emojiId) {
        runs.push({ kind: 'text', text: emojiId });
      }
    }
  }
  flush();
  return runs;
}

/** JSON Lines の1行を ChatMessage にする。対象外・不正な行は null。 */
export function parseYoutubeLine(line: string): ChatMessage | null {
  let root: unknown;
  try {
    root = JSON.parse(line);
  } catch {
    return null;
  }
  const actions = getArray(getObject(root, 'replayChatItemAction'), 'actions');
  if (!actions || actions.length === 0) return null;
  const item = getObject(getObject(actions[0], 'addChatItemAction'), 'item');
  if (!item) return null;

  let renderer = getObject(item, 'liveChatTextMessageRenderer');
  let bodyRequired = false;
  if (!renderer) {
    renderer = getObject(item, 'liveChatPaidMessageRenderer') ?? getObject(item, 'liveChatMembershipItemRenderer');
    bodyRequired = true;
  }
  if (!renderer) return null;

  const timestampText = getString(getObject(renderer, 'timestampText'), 'simpleText');
  if (timestampText === undefined) return null;
  const seconds = parseTimestamp(timestampText);
  if (seconds === null) return null;

  const author = getString(getObject(renderer, 'authorName'), 'simpleText') ?? '';
  const runs = parseRuns(renderer);
  if (bodyRequired && runs.length === 0) return null;
  return { timeSeconds: seconds, author, ...badgeFlags(renderer), runs };
}

export async function parseYoutubeFile(
  file: Blob,
  onMessage: (message: ChatMessage) => void,
  sliceBytes?: number,
): Promise<void> {
  const splitter = new LineSplitter((line) => {
    if (line.trim().length === 0) return;
    const message = parseYoutubeLine(line);
    if (message) onMessage(message);
  });
  for await (const text of readTextChunks(file, sliceBytes)) splitter.push(text);
  splitter.flush();
}
