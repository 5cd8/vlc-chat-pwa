import type { ParseResponse } from '../chat/workerMessages';
import type { Disposable, ParseHandlers } from './sessionState';

/** 解析Workerを始める。dispose() で terminate() する（解析中の選び直しでピークメモリを二重にしない）。 */
export function startChatParse(file: File, handlers: ParseHandlers): Disposable {
  const worker = new Worker(new URL('../chat/parseWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ParseResponse>): void => {
    const message = event.data;
    if (message.type === 'progress') handlers.onProgress(message.count);
    else if (message.type === 'done') handlers.onDone(message.store);
    else handlers.onError(message.message);
  };
  worker.onerror = (event): void => handlers.onError(event.message || 'チャットの解析中にエラーが起きました');
  worker.postMessage({ file });
  return { dispose: () => worker.terminate() };
}
