import { transferListOf } from './chatStore';
import { parseChatFile } from './parseChat';
import type { ChatStore } from './types';

export type ParseRequest = { file: File };
export type ParseResponse =
  | { type: 'progress'; count: number }
  | { type: 'done'; store: ChatStore }
  | { type: 'error'; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
  postMessage(message: ParseResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  void parseChatFile(event.data.file, {
    onProgress: (count) => scope.postMessage({ type: 'progress', count }),
  }).then(
    (store) => scope.postMessage({ type: 'done', store }, transferListOf(store)),
    (error: unknown) =>
      scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
  );
};
