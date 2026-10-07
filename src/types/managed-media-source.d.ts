// ManagedMediaSource（iOS 17.1以降）は lib.dom に無いので、使う分だけ宣言する。
// https://developer.mozilla.org/en-US/docs/Web/API/ManagedMediaSource

interface ManagedSourceBuffer extends SourceBuffer {
  addEventListener(type: 'bufferedchange', listener: (event: Event) => void): void;
  removeEventListener(type: 'bufferedchange', listener: (event: Event) => void): void;
}

interface ManagedMediaSource extends MediaSource {
  /** UAが供給を求めているか（startstreaming で true、endstreaming で false） */
  readonly streaming: boolean;
  addSourceBuffer(type: string): ManagedSourceBuffer;
  addEventListener(type: 'startstreaming' | 'endstreaming', listener: (event: Event) => void): void;
  removeEventListener(type: 'startstreaming' | 'endstreaming', listener: (event: Event) => void): void;
}

declare const ManagedMediaSource: {
  prototype: ManagedMediaSource;
  new (): ManagedMediaSource;
  isTypeSupported(type: string): boolean;
};

interface HTMLVideoElement {
  /** iPhone Safari では、これを true にしないと sourceopen が発火しない */
  disableRemotePlayback: boolean;
}
