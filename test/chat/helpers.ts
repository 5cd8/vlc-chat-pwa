import { parseTwitchFile } from '../../src/chat/twitchParser';
import type { ChatMessage } from '../../src/chat/types';
import { parseYoutubeFile } from '../../src/chat/youtubeParser';

export function blobOf(text: string): Blob {
  return new Blob([new TextEncoder().encode(text)]);
}

export async function collectTwitch(text: string, sliceBytes?: number): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  await parseTwitchFile(blobOf(text), (m) => out.push(m), sliceBytes);
  return out;
}

export async function collectYoutube(text: string, sliceBytes?: number): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  await parseYoutubeFile(blobOf(text), (m) => out.push(m), sliceBytes);
  return out;
}

export function twitchComment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content_offset_seconds: 12.9,
    commenter: { display_name: 'Alice', name: 'alice' },
    message: {
      body: 'hello Kappa',
      fragments: [
        { text: 'hello ', emoticon: null },
        { text: 'Kappa', emoticon: { emoticon_id: '25' } },
      ],
      user_badges: [],
    },
    ...over,
  };
}

export function twitchFile(comments: unknown[], rootExtra: Record<string, unknown> = {}): string {
  return JSON.stringify({ streamer: { name: 'x' }, ...rootExtra, comments, video: { end: 1 } });
}

export function youtubeLine(renderer: Record<string, unknown>, kind = 'liveChatTextMessageRenderer'): string {
  return JSON.stringify({
    replayChatItemAction: { actions: [{ addChatItemAction: { item: { [kind]: renderer } } }] },
  });
}

export function ytRenderer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestampText: { simpleText: '1:02' },
    authorName: { simpleText: 'Bob' },
    message: { runs: [{ text: 'hi' }] },
    ...over,
  };
}
