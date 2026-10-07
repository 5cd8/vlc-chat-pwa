// MKV→フラグメントMP4 に詰め替えるときの、MSE用のMIMEタイプの組み立て（純粋関数）。

/**
 * MP4内のコーデック文字列として、Opus は先頭大文字の `Opus` が正式。iPhone の ManagedMediaSource は
 * 小文字の `opus` を偽にする（実機で確認：計画3.1節 U3）。
 */
export function toMp4CodecString(codec: string): string {
  return codec.toLowerCase() === 'opus' ? 'Opus' : codec;
}

/** 音声が無ければ映像だけの codecs にする。 */
export function buildMp4Mime(videoCodec: string, audioCodec: string | null): string {
  const codecs = audioCodec === null ? videoCodec : `${videoCodec}, ${toMp4CodecString(audioCodec)}`;
  return `video/mp4; codecs="${codecs}"`;
}

export type TrackProbe = {
  /** Mediabunny のコーデック名（`track.getCodec()`）。知らないコーデックは null */
  codec: string | null;
  /** `track.getCodecParameterString()` */
  codecString: string | null;
  /** `track.getDecoderConfig()` が null でない */
  hasDecoderConfig: boolean;
};

/** 再生できない理由を返す。再生できるなら null。音声トラックが無い（null）のは問題としない。 */
export function checkPlayable(video: TrackProbe | null, audio: TrackProbe | null): string | null {
  if (!video) return '映像トラックがありません';
  const v = unplayableTrack('映像', video);
  if (v) return v;
  return audio ? unplayableTrack('音声', audio) : null;
}

function unplayableTrack(label: string, t: TrackProbe): string | null {
  if (t.codec === null) return `${label}のコーデックに対応していません`;
  if (!t.hasDecoderConfig || t.codecString === null) return `${label}のコーデック情報を取得できません（${t.codec}）`;
  return null;
}
