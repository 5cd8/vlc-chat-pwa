import { CHAT_MAX_ITEMS } from '../limits';
import { decodeMessage } from './chatStore';
import type { ChatMessage, ChatStore } from './types';

/** floor済みの昇順 times から、t 以下の最大の添字を返す（無ければ -1）。 */
export function indexAtOrBefore(times: Uint32Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

export type SyncAction =
  | { type: 'none' }
  /** チャット欄を作り直す（messages が最新の表示内容。空もあり得る）。 */
  | { type: 'reset'; messages: ChatMessage[] }
  | { type: 'append'; messages: ChatMessage[] };

/** PC版 ChatSyncService＋MainWindow.SyncChatToTime と同じ規則。 */
export class ChatSync {
  private store: ChatStore | null = null;
  private lastIndex = -1;

  /** 解析が終わったとき、または選び直したときに呼ぶ。直後の update で現在位置へ追従する。 */
  setStore(store: ChatStore | null): void {
    this.store = store;
    this.lastIndex = -1;
  }

  update(currentTimeSeconds: number): SyncAction {
    const store = this.store;
    if (!store || store.times.length === 0) return { type: 'none' };
    const target = indexAtOrBefore(store.times, Math.floor(currentTimeSeconds));
    if (target === this.lastIndex) return { type: 'none' };
    if (target === -1) {
      this.lastIndex = -1;
      return { type: 'reset', messages: [] };
    }
    if (target < this.lastIndex || target - this.lastIndex > CHAT_MAX_ITEMS) {
      this.lastIndex = target;
      return { type: 'reset', messages: this.messagesThrough(store, target) };
    }
    const messages: ChatMessage[] = [];
    for (let i = this.lastIndex + 1; i <= target; i++) messages.push(decodeMessage(store, i));
    this.lastIndex = target;
    return { type: 'append', messages };
  }

  private messagesThrough(store: ChatStore, index: number): ChatMessage[] {
    const start = Math.max(0, index - (CHAT_MAX_ITEMS - 1));
    const messages: ChatMessage[] = [];
    for (let i = start; i <= index; i++) messages.push(decodeMessage(store, i));
    return messages;
  }
}
