import { CHAT_MAX_ITEMS } from '../limits';
import type { EmojiImageCache } from '../emoji/emojiImageCache';
import type { ChatMessage, ChatRun } from '../chat/types';
import { isNearBottom } from './isNearBottom';
import { LatestOnly } from './latestOnly';

/** チャット欄。本文・投稿者名は textContent で挿入する（外部データなので innerHTML は使わない）。 */
export class ChatView {
  private readonly generation = new LatestOnly();

  constructor(
    private readonly container: HTMLElement,
    private readonly emojis: EmojiImageCache,
  ) {}

  /** 作り直し（シーク・動画の切り替え）。古い世代の絵文字の取得結果は捨てる。 */
  reset(messages: readonly ChatMessage[]): void {
    this.generation.advance();
    this.container.replaceChildren();
    this.append(messages, true);
  }

  append(messages: readonly ChatMessage[], forceScroll = false): void {
    if (messages.length === 0) return;
    const follow =
      forceScroll || isNearBottom(this.container.scrollTop, this.container.clientHeight, this.container.scrollHeight);
    const fragment = document.createDocumentFragment();
    for (const message of messages) fragment.appendChild(this.renderLine(message));
    this.container.appendChild(fragment);
    while (this.container.childElementCount > CHAT_MAX_ITEMS) this.container.firstElementChild?.remove();
    if (follow) this.container.scrollTop = this.container.scrollHeight;
  }

  private renderLine(message: ChatMessage): HTMLElement {
    const line = document.createElement('div');
    line.className = 'chat-line';
    const author = document.createElement('span');
    author.className = 'chat-author';
    if (message.isOwner || message.isModerator) {
      // 色だけに頼らず、記号でも区別する
      const mark = document.createElement('span');
      mark.className = message.isOwner ? 'chat-mark owner' : 'chat-mark moderator';
      mark.textContent = message.isOwner ? '★' : '◆';
      mark.setAttribute('role', 'img');
      mark.setAttribute('aria-label', message.isOwner ? '配信者' : 'モデレーター');
      author.appendChild(mark);
      author.classList.add(message.isOwner ? 'owner' : 'moderator');
    }
    author.appendChild(document.createTextNode(message.author));
    const body = document.createElement('span');
    body.className = 'chat-body';
    for (const run of message.runs) body.appendChild(this.renderRun(run));
    line.append(author, document.createTextNode('　'), body);
    return line;
  }

  private renderRun(run: ChatRun): Node {
    if (run.kind === 'text') return document.createTextNode(run.text);
    // 画像を取得できるまで（取得できなければずっと）alt を表示する
    const holder = document.createElement('span');
    holder.className = 'chat-emoji';
    holder.textContent = run.alt;
    const token = this.generation.token();
    void this.emojis.getOrLoad(run.url).then((objectUrl) => {
      if (!objectUrl || !this.generation.isCurrent(token) || !holder.isConnected) return;
      const img = document.createElement('img');
      img.alt = run.alt;
      img.src = objectUrl;
      holder.replaceChildren(img);
    });
    return holder;
  }
}
