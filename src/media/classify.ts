// 選択された File を拡張子で振り分ける（Issue要件2）。ファイル名の一致は前提にしない。

export type VideoKind = 'native' | 'mkv';

type Named = { name: string };

export type Classification<F extends Named> = {
  video?: F;
  videoKind?: VideoKind;
  chat?: F;
  emoji?: F;
  /** 同じ種類が複数選ばれたときの、採用しなかったファイル名 */
  extras: string[];
  /** 拡張子が対象外のファイル名 */
  unknown: string[];
  /** 足りない種類（動画とチャットが無いと再生を始めない。sqlite は省略可） */
  missing: ('動画' | 'チャット')[];
};

const NATIVE_VIDEO = ['.mp4', '.mov', '.webm'];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function classifyFiles<F extends Named>(files: readonly F[]): Classification<F> {
  const result: Classification<F> = { extras: [], unknown: [], missing: [] };
  for (const file of files) {
    const ext = extensionOf(file.name);
    if (NATIVE_VIDEO.includes(ext) || ext === '.mkv') {
      if (result.video) result.extras.push(file.name);
      else {
        result.video = file;
        result.videoKind = ext === '.mkv' ? 'mkv' : 'native';
      }
    } else if (ext === '.json') {
      if (result.chat) result.extras.push(file.name);
      else result.chat = file;
    } else if (ext === '.sqlite') {
      if (result.emoji) result.extras.push(file.name);
      else result.emoji = file;
    } else {
      result.unknown.push(file.name);
    }
  }
  if (!result.video) result.missing.push('動画');
  if (!result.chat) result.missing.push('チャット');
  return result;
}
