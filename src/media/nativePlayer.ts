// MP4/MOV/WebM は <video> にそのまま渡す。JSはバイトに触れない（JSヒープ ≈ 0）。

export type PlayerCallbacks = {
  /** 再生できない・再生が止まった理由（画面に表示する） */
  onError(message: string): void;
  /** メタデータが読めて、再生を始められる */
  onReady(): void;
};

export function describeMediaError(video: HTMLVideoElement): string {
  const code = video.error?.code;
  switch (code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return '動画の読み込みが中断されました';
    case MediaError.MEDIA_ERR_NETWORK:
      return '動画ファイルを読み込めませんでした';
    case MediaError.MEDIA_ERR_DECODE:
      return '動画をデコードできませんでした（ファイルが壊れているか、この端末で復号できないコーデックです）';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'この動画の形式（コーデック）はこの端末で再生できません';
    default:
      return `動画を再生できません${video.error?.message ? `（${video.error.message}）` : ''}`;
  }
}

export function createNativePlayer(video: HTMLVideoElement, file: File, callbacks: PlayerCallbacks): { dispose(): void } {
  video.playsInline = true;
  video.preservesPitch = true; // 要件3「音程は保つ」。既定値に頼らず明示する
  video.defaultPlaybackRate = 1;
  const url = URL.createObjectURL(file);
  // stalled は再生中も約6秒ごとに出る（実機）ので、エラー扱いにしない。中断の判定は waiting・error だけで行う
  const onError = (): void => callbacks.onError(describeMediaError(video));
  const onMeta = (): void => callbacks.onReady();
  video.addEventListener('error', onError);
  video.addEventListener('loadedmetadata', onMeta, { once: true });
  video.src = url;
  video.playbackRate = 1;
  return {
    dispose(): void {
      video.removeEventListener('error', onError);
      video.removeEventListener('loadedmetadata', onMeta);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    },
  };
}
