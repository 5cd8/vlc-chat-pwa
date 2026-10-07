// ルートオブジェクトの指定プロパティ（配列）の要素を、1件ずつ文字列として切り出す逐次スキャナ。
// 文字列内のエスケープ（\"）・チャンク境界での分断を扱う。ルートの他のプロパティは、値が文字列・
// スカラー・入れ子のどれでも、溜めずに読み捨てる（TwitchDownloaderの embeddedData のような巨大な値のため）。

const enum S {
  RootStart, // ルートの '{' を待つ
  RootKey, // キーの '"' または '}'
  InKey, // キー文字列の中
  AfterKey, // ':' を待つ
  ValueStart, // 値の先頭
  ArrayElement, // 対象配列の要素の先頭（',' や ']' も）
  Capture, // 要素オブジェクトを溜めている
  SkipNested, // {} [] の読み飛ばし
  SkipString,
  SkipScalar,
  Done,
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

export class JsonArrayScanner {
  private state: S = S.RootStart;
  private key = '';
  private isTarget = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private parts: string[] = [];
  /** 読み飛ばし終了後に戻る状態 */
  private returnTo: S = S.RootKey;
  private _malformed = false;

  constructor(
    private readonly property: string,
    private readonly onElement: (json: string) => void,
  ) {}

  /** 対象配列が閉じた（またはルートが閉じた・壊れていた）とき真。以降の push は無視する。 */
  get finished(): boolean {
    return this.state === S.Done;
  }

  get malformed(): boolean {
    return this._malformed;
  }

  push(text: string): void {
    const n = text.length;
    let i = 0;
    let captureStart = this.state === S.Capture ? 0 : -1;
    while (i < n && this.state !== S.Done) {
      switch (this.state) {
        case S.RootStart: {
          const c = text.charCodeAt(i++);
          if (c === 0x7b) this.state = S.RootKey;
          else if (!isWhitespace(c)) this.fail();
          break;
        }
        case S.RootKey: {
          const c = text.charCodeAt(i++);
          if (c === QUOTE) {
            this.key = '';
            this.escaped = false;
            this.state = S.InKey;
          } else if (c === 0x7d) {
            this.state = S.Done; // 対象のプロパティが無かった
          } else if (c !== 0x2c && !isWhitespace(c)) {
            this.fail();
          }
          break;
        }
        case S.InKey: {
          const c = text.charCodeAt(i++);
          if (this.escaped) {
            this.escaped = false;
            this.key += String.fromCharCode(c);
          } else if (c === BACKSLASH) {
            this.escaped = true;
            this.key += '\\';
          } else if (c === QUOTE) {
            this.isTarget = this.key === this.property;
            this.state = S.AfterKey;
          } else if (this.key.length < 256) {
            this.key += String.fromCharCode(c);
          }
          break;
        }
        case S.AfterKey: {
          const c = text.charCodeAt(i++);
          if (c === 0x3a) this.state = S.ValueStart;
          else if (!isWhitespace(c)) this.fail();
          break;
        }
        case S.ValueStart: {
          const c = text.charCodeAt(i);
          if (isWhitespace(c)) {
            i++;
          } else if (this.isTarget && c === 0x5b) {
            i++;
            this.state = S.ArrayElement;
          } else {
            if (this.startSkip(c)) continue; // スカラーは先頭の文字も読み飛ばしの対象
            i++;
          }
          break;
        }
        case S.ArrayElement: {
          const c = text.charCodeAt(i);
          if (c === 0x5d) {
            i++;
            this.state = S.Done;
          } else if (c === 0x7b) {
            this.depth = 1;
            this.inString = false;
            this.escaped = false;
            this.parts.length = 0;
            captureStart = i;
            i++;
            this.state = S.Capture;
          } else if (c === 0x2c || isWhitespace(c)) {
            i++;
          } else if (c === 0x7d) {
            this.fail(); // 配列の中に '}' は来ない。読み飛ばしが進まず止まらなくなるのを防ぐ
          } else {
            // オブジェクト以外の要素は読み飛ばして継続する
            this.returnTo = S.ArrayElement;
            if (this.startSkip(c)) continue;
            i++;
          }
          break;
        }
        case S.Capture: {
          i = this.scanNested(text, i);
          if (this.depth === 0) {
            this.parts.push(text.slice(captureStart, i));
            const json = this.parts.length === 1 ? this.parts[0]! : this.parts.join('');
            this.parts.length = 0;
            captureStart = -1;
            this.state = S.ArrayElement;
            this.onElement(json);
          }
          break;
        }
        case S.SkipNested: {
          i = this.scanNested(text, i);
          if (this.depth === 0) this.state = this.returnTo;
          break;
        }
        case S.SkipString: {
          const c = text.charCodeAt(i++);
          if (this.escaped) this.escaped = false;
          else if (c === BACKSLASH) this.escaped = true;
          else if (c === QUOTE) this.state = this.returnTo;
          break;
        }
        case S.SkipScalar: {
          const c = text.charCodeAt(i);
          if (c === 0x2c || c === 0x7d || c === 0x5d || isWhitespace(c)) this.state = this.returnTo;
          else i++;
          break;
        }
      }
    }
    // チャンク末尾まで要素の途中なら、ここまでを溜めて次の push に持ち越す
    if (this.state === S.Capture && captureStart >= 0) this.parts.push(text.slice(captureStart));
  }

  /** 値の先頭の文字から、読み飛ばしの状態を決める。スカラー（先頭の文字を消費しない）なら true。 */
  private startSkip(c: number): boolean {
    if (this.state === S.ValueStart) this.returnTo = S.RootKey;
    if (c === QUOTE) {
      this.escaped = false;
      this.state = S.SkipString;
      return false;
    } else if (c === 0x7b || c === 0x5b) {
      this.depth = 1;
      this.inString = false;
      this.escaped = false;
      this.state = S.SkipNested;
      return false;
    }
    this.state = S.SkipScalar;
    return true;
  }

  /** {} [] の深さを追って、閉じた位置の次（または末尾）を返す。depth が 0 になれば閉じている。 */
  private scanNested(text: string, from: number): number {
    const n = text.length;
    let i = from;
    let depth = this.depth;
    let inString = this.inString;
    let escaped = this.escaped;
    while (i < n) {
      const c = text.charCodeAt(i++);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === BACKSLASH) escaped = true;
        else if (c === QUOTE) inString = false;
      } else if (c === QUOTE) {
        inString = true;
      } else if (c === 0x7b || c === 0x5b) {
        depth++;
      } else if (c === 0x7d || c === 0x5d) {
        depth--;
        if (depth === 0) break;
      }
    }
    this.depth = depth;
    this.inString = inString;
    this.escaped = escaped;
    return i;
  }

  private fail(): void {
    this._malformed = true;
    this.state = S.Done;
  }
}

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xfeff;
}
