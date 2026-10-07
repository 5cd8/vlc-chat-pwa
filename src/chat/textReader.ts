import { FILE_READ_SLICE_BYTES } from '../limits';

/**
 * ファイルを sliceBytes ずつ読み、UTF-8として復号した文字列を順に返す。
 * blob.stream() は使わない（WebKitで大きなファイルが失敗・メモリが蓄積するため。計画4.1節）。
 * UTF-8 BOM は TextDecoder が先頭で取り除く。
 */
export async function* readTextChunks(file: Blob, sliceBytes: number = FILE_READ_SLICE_BYTES): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  for (let offset = 0; offset < file.size; offset += sliceBytes) {
    const buffer = await file.slice(offset, offset + sliceBytes).arrayBuffer();
    const text = decoder.decode(buffer, { stream: true });
    if (text.length > 0) yield text;
  }
  const rest = decoder.decode();
  if (rest.length > 0) yield rest;
}

/** 改行（\n、\r\n）で行に分ける。単独の \r は区切りにしない（PC版との差は計画5.2節で許容済み）。 */
export class LineSplitter {
  private carry = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      let line = text.slice(start, nl);
      if (this.carry.length > 0) {
        line = this.carry + line;
        this.carry = '';
      }
      this.emit(line);
      start = nl + 1;
    }
    if (start < text.length) this.carry += text.slice(start);
  }

  /** 最終行に改行が無い場合のために、読み終わったら呼ぶ。 */
  flush(): void {
    if (this.carry.length > 0) {
      const line = this.carry;
      this.carry = '';
      this.emit(line);
    }
  }

  private emit(line: string): void {
    this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  }
}
