import { ChatStoreBuilder, type ChatStoreBuilderOptions } from './chatStore';
import { detectChatFormat } from './detect';
import { parseTwitchFile } from './twitchParser';
import type { ChatStore } from './types';
import { parseYoutubeFile } from './youtubeParser';

export type ParseChatOptions = ChatStoreBuilderOptions & {
  sliceBytes?: number;
  onProgress?: (count: number) => void;
};

const PROGRESS_INTERVAL = 2000;

/** チャットファイルを判定・解析して ChatStore にする。 */
export async function parseChatFile(file: Blob, options: ParseChatOptions = {}): Promise<ChatStore> {
  const builder = new ChatStoreBuilder(options);
  let lastReported = 0;
  const onMessage = (message: Parameters<ChatStoreBuilder['add']>[0]): void => {
    builder.add(message);
    if (options.onProgress && builder.count - lastReported >= PROGRESS_INTERVAL) {
      lastReported = builder.count;
      options.onProgress(builder.count);
    }
  };
  const format = await detectChatFormat(file);
  if (format === 'youtube') await parseYoutubeFile(file, onMessage, options.sliceBytes);
  else await parseTwitchFile(file, onMessage, options.sliceBytes);
  return builder.build();
}
