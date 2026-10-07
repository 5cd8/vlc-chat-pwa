import { transferListOf } from './chatStore';
import { parseChatFile } from './parseChat';
import type { ParseRequest, ParseResponse } from './workerMessages';

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
