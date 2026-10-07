import { openEmojiDb } from '../emoji/sqliteReader';
import { EmojiImageCache } from '../emoji/emojiImageCache';
import { ChatSync } from '../chat/sync';
import { createMkvPlayer, type MkvPlayerHandle } from '../media/mkvPlayer';
import { createNativePlayer } from '../media/nativePlayer';
import { ChatView } from './chatView';
import { startChatParse } from './chatParseClient';
import { Controls } from './controls';
import { SessionController, type SessionState } from './sessionState';

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がありません`);
  return el as T;
}

export function startApp(): void {
  const video = must<HTMLVideoElement>('video');
  const chatEl = must('chat');
  const chatNote = must('chat-note');
  const statusEl = must('status');
  const pick = must<HTMLButtonElement>('pick');
  const input = must<HTMLInputElement>('file-input');

  const emojiCache = new EmojiImageCache();
  const chatView = new ChatView(chatEl, emojiCache);
  const sync = new ChatSync();
  const controls = new Controls(must('controls'), video);

  let playerNote = '';
  // 診断表示（暫定コード。⑦で配線ごと撤去する）
  const diagEl = document.createElement('pre');
  diagEl.id = 'diag';
  document.body.appendChild(diagEl);
  let diagnostics: () => string = () => '';
  setInterval(() => {
    const text = diagnostics();
    diagEl.textContent = text;
    diagEl.hidden = text === '';
  }, 1000);
  let lastState: SessionState | null = null;

  const syncChat = (): void => {
    const action = sync.update(video.currentTime);
    if (action.type === 'reset') chatView.reset(action.messages);
    else if (action.type === 'append') chatView.append(action.messages);
  };

  const render = (state: SessionState): void => {
    lastState = state;
    const lines: string[] = [];
    const s = state.selection;
    lines.push(`動画: ${s.video ?? '未選択'}`);
    lines.push(`チャット: ${s.chat ?? '未選択'}`);
    lines.push(s.emoji ? `絵文字: ${s.emoji}` : '絵文字: 未選択（省略時は代替テキストで表示）');
    if (s.missing.length > 0) lines.push(`再生には動画とチャットが必要です（不足: ${s.missing.join('・')}）`);
    if (s.ignored.length > 0) lines.push(`使わないファイル: ${s.ignored.join('、')}`);
    if (state.emoji.status === 'opening') lines.push('絵文字を開いています…');
    if (state.emoji.status === 'failed') lines.push(`絵文字を読み込めません（代替テキストで表示します）: ${state.emoji.message ?? ''}`);
    for (const w of state.emoji.warnings) lines.push(`注意: ${w}`);
    if (playerNote) lines.push(playerNote);
    statusEl.replaceChildren(
      ...lines.map((text) => {
        const p = document.createElement('p');
        p.textContent = text;
        return p;
      }),
    );

    const c = state.chat;
    chatNote.textContent =
      c.status === 'parsing'
        ? `チャットを読み込み中（${c.count}件）`
        : c.status === 'ready'
          ? ''
          : c.status === 'none'
            ? ''
            : (c.message ?? 'チャットを読み取れませんでした');
  };

  const setPlayerNote = (note: string): void => {
    playerNote = note;
    if (lastState) render(lastState);
  };

  const controller = new SessionController({
    startChatParse,
    createPlayer: (file, kind) => {
      controls.resetRate();
      controls.setEnabled(false);
      playerNote = '準備中…';
      const callbacks = {
        onReady: () => {
          controls.setEnabled(true);
          setPlayerNote('');
        },
        onError: (message: string) => {
          controls.setEnabled(false);
          setPlayerNote(message);
        },
      };
      if (kind === 'mkv') {
        const mkv: MkvPlayerHandle = createMkvPlayer(video, file, {
          ...callbacks,
          onWarning: (message) => setPlayerNote(`注意: ${message}`),
        });
        diagnostics = () => mkv.diagnostics();
        return mkv;
      }
      diagnostics = () => '';
      return createNativePlayer(video, file, callbacks);
    },
    openEmoji: openEmojiDb,
    resetViews: () => {
      playerNote = '';
      chatView.reset([]);
      emojiCache.clear();
      sync.setStore(null);
      controls.setEnabled(false);
    },
    onChatReady: (store) => {
      sync.setStore(store);
      syncChat(); // 解析中にシークされていても、再生位置へ追従する
    },
    setEmojiSource: (db) => emojiCache.setSource(db),
    onChange: render,
  });

  // 再生位置への追従：timeupdate（Safariで約4Hz）・シーク・速度変更。毎フレームの更新はしない
  for (const type of ['timeupdate', 'seeked', 'ratechange']) video.addEventListener(type, syncChat);

  pick.addEventListener('click', () => {
    input.value = ''; // 同じファイルを選び直しても change が発火するように、開く直前に空にする
    input.click();
  });
  input.addEventListener('change', () => controller.select(Array.from(input.files ?? [])));
  window.addEventListener('pagehide', () => controller.dispose());
  render(controller.getState());
}
