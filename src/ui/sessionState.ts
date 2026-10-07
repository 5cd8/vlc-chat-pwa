import { classifyFiles, type VideoKind } from '../media/classify';
import type { EmojiDb, OpenError } from '../emoji/sqliteReader';
import type { ChatStore } from '../chat/types';

// ファイルの選び直しで、旧プレーヤー・解析Worker・絵文字を破棄してから作り直す状態遷移（4.3節）。
// DOM・Worker・MediaSource に触れない。実物は deps として注入する。

export type Disposable = { dispose(): void };

export type ParseHandlers = {
  onProgress(count: number): void;
  onDone(store: ChatStore): void;
  onError(message: string): void;
};

export type SessionDeps = {
  /** 解析Workerを始める。dispose() で terminate() する。 */
  startChatParse(file: File, handlers: ParseHandlers): Disposable;
  /** 動画のプレーヤーを作る。dispose() で URL・MediaSource などを解放する。 */
  createPlayer(file: File, kind: VideoKind): Disposable;
  openEmoji(file: File): Promise<EmojiDb | OpenError>;
  /** 画面・状態の初期化：チャット欄を空に、絵文字キャッシュを全件 revoke、同期状態を捨てる。 */
  resetViews(): void;
  /** 解析が終わったストアを受け取る（同期の対象にする）。 */
  onChatReady(store: ChatStore): void;
  /** 絵文字の読み出し元を差し替える（null で無し）。 */
  setEmojiSource(db: EmojiDb | null): void;
  onChange(state: SessionState): void;
};

export type SessionState = {
  selection: {
    video?: string;
    chat?: string;
    emoji?: string;
    /** 採用しなかったファイル（同じ種類の余り・対象外の拡張子） */
    ignored: string[];
    missing: string[];
  };
  /** 動画とチャットがそろって、再生を始められる */
  active: boolean;
  chat: { status: 'none' | 'parsing' | 'ready' | 'empty' | 'error'; count: number; message?: string };
  emoji: { status: 'none' | 'opening' | 'ready' | 'failed'; message?: string; warnings: string[] };
};

const EMPTY_STATE: SessionState = {
  selection: { ignored: [], missing: [] },
  active: false,
  chat: { status: 'none', count: 0 },
  emoji: { status: 'none', warnings: [] },
};

export class SessionController {
  private parse: Disposable | null = null;
  private player: Disposable | null = null;
  private emoji: EmojiDb | null = null;
  /** 選び直しのたびに進める。古い非同期の結果（絵文字を開く処理など）を捨てるため。 */
  private generation = 0;
  private state: SessionState = EMPTY_STATE;

  constructor(private readonly deps: SessionDeps) {}

  getState(): SessionState {
    return this.state;
  }

  /** ファイルが選ばれた。選ばれた組で最初から作り直す。 */
  select(files: readonly File[]): void {
    this.teardown();
    const generation = ++this.generation;
    const c = classifyFiles(files);
    const ignored = [...c.extras, ...c.unknown];
    const selection: SessionState['selection'] = {
      video: c.video?.name,
      chat: c.chat?.name,
      emoji: c.emoji?.name,
      ignored,
      missing: c.missing,
    };
    if (!c.video || !c.chat || !c.videoKind) {
      this.update({ ...EMPTY_STATE, selection });
      return;
    }
    this.update({
      selection,
      active: true,
      chat: { status: 'parsing', count: 0 },
      emoji: { status: c.emoji ? 'opening' : 'none', warnings: [] },
    });

    this.player = this.deps.createPlayer(c.video, c.videoKind);
    this.parse = this.deps.startChatParse(c.chat, {
      onProgress: (count) => {
        if (generation === this.generation) this.update({ ...this.state, chat: { status: 'parsing', count } });
      },
      onDone: (store) => {
        if (generation !== this.generation) return;
        const count = store.times.length;
        this.parse?.dispose(); // 解析が終わったらWorkerを終了して解放する
        this.parse = null;
        this.deps.onChatReady(store);
        this.update({
          ...this.state,
          chat: count === 0 ? { status: 'empty', count: 0, message: 'チャットを読み取れませんでした' } : { status: 'ready', count },
        });
      },
      onError: (message) => {
        if (generation !== this.generation) return;
        this.parse?.dispose();
        this.parse = null;
        this.update({ ...this.state, chat: { status: 'error', count: 0, message } });
      },
    });

    if (c.emoji) {
      void this.deps.openEmoji(c.emoji).then((result) => {
        if ('get' in result) {
          if (generation !== this.generation) {
            result.close(); // 選び直しで不要になった
            return;
          }
          this.emoji = result;
          this.deps.setEmojiSource(result);
          this.update({ ...this.state, emoji: { status: 'ready', warnings: result.warnings } });
        } else if (generation === this.generation) {
          this.update({ ...this.state, emoji: { status: 'failed', message: result.reason, warnings: [] } });
        }
      });
    }
  }

  /** すべて破棄する（ページを閉じるとき）。 */
  dispose(): void {
    this.generation++;
    this.teardown();
    this.update(EMPTY_STATE);
  }

  private teardown(): void {
    // 解析Workerを先に止めてから、プレーヤー・絵文字を破棄する（解析中のピークメモリを二重にしない）
    this.parse?.dispose();
    this.parse = null;
    this.player?.dispose();
    this.player = null;
    this.deps.setEmojiSource(null);
    this.emoji?.close();
    this.emoji = null;
    this.deps.resetViews();
  }

  private update(state: SessionState): void {
    this.state = state;
    this.deps.onChange(state);
  }
}
