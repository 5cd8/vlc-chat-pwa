import {
  ALL_FORMATS,
  AppendOnlyStreamTarget,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  type EncodedPacket,
} from 'mediabunny';
import { MIN_FRAGMENT_SECONDS, MKV_SOURCE_CACHE_BYTES } from '../limits';
import { buildMp4Mime, checkPlayable, type TrackProbe } from './codecString';
import {
  classifyFragmentBytes,
  estimateFragmentBytes,
  GOP_REFUSE_MESSAGE,
  GOP_WARN_MESSAGE,
  probeMaxGopSeconds,
} from './gopPolicy';
import { describeMediaError, type PlayerCallbacks } from './nativePlayer';
import { PacketPump, type OutputFactory, type Packet, type TrackReader } from './packetPump';
import { SourceBufferQueue } from './sourceBufferQueue';

// MKV を再エンコードなしでフラグメントMP4にして ManagedMediaSource に供給し、通常の <video> で再生する（D1）。
// 本ファイルは、実物（<video>・ManagedMediaSource・Mediabunny）をポンプのポートに包む配線だけを持つ。
// 供給の判断は packetPump.ts・pumpPolicy.ts・bufferAccounting.ts にあり、偽物を使った単体テストの対象になっている。

export type MkvPlayerCallbacks = PlayerCallbacks & {
  onWarning(message: string): void;
};

export type MkvPlayerHandle = {
  dispose(): void;
  /** 診断表示用（暫定。PR作成前に撤去する） */
  diagnostics(): string;
};

type MseCtor = { new (): MediaSource; isTypeSupported(type: string): boolean };

function mediaSourceCtor(): MseCtor | null {
  const g = globalThis as unknown as { ManagedMediaSource?: MseCtor; MediaSource?: MseCtor };
  // デスクトップのChromeなど、通常の MediaSource でも動作確認できるようにする（iPhoneは ManagedMediaSource のみ）
  return g.ManagedMediaSource ?? g.MediaSource ?? null;
}

function wrap(p: EncodedPacket | null): Packet | null {
  return p ? { timestamp: p.timestamp, isKey: p.type === 'key', byteLength: p.byteLength, raw: p } : null;
}

function trackReader(sink: EncodedPacketSink): TrackReader {
  const raw = (p: Packet): EncodedPacket => p.raw as EncodedPacket;
  return {
    getFirst: async () => wrap(await sink.getFirstPacket()),
    getFirstKey: async () => wrap(await sink.getFirstKeyPacket()),
    getKeyAtOrBefore: async (t) => wrap(await sink.getKeyPacket(t)),
    getAtOrBefore: async (t) => wrap(await sink.getPacket(t)),
    getNext: async (p) => wrap(await sink.getNextPacket(raw(p))),
    getNextKey: async (p) => wrap(await sink.getNextKeyPacket(raw(p))),
  };
}

async function probeTrack(
  track: {
    getCodec(): Promise<string | null>;
    getCodecParameterString(): Promise<string | null>;
    getDecoderConfig(): Promise<unknown>;
  } | null,
): Promise<TrackProbe | null> {
  if (!track) return null;
  return {
    codec: await track.getCodec(),
    codecString: await track.getCodecParameterString(),
    hasDecoderConfig: (await track.getDecoderConfig()) !== null,
  };
}

export function createMkvPlayer(video: HTMLVideoElement, file: File, callbacks: MkvPlayerCallbacks): MkvPlayerHandle {
  let disposed = false;
  let teardown: (() => void) | null = null;
  let diag: () => string = () => '準備中';

  const fail = (message: string): void => {
    if (!disposed) callbacks.onError(message);
  };

  void (async () => {
    const Ctor = mediaSourceCtor();
    if (!Ctor) return fail('この端末は MediaSource に対応していません（iPhoneは iOS 17.1以降が必要です）');

    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file, { maxCacheSize: MKV_SOURCE_CACHE_BYTES }) });
    let url: string | null = null;
    let pump: PacketPump | null = null;
    let ms: MediaSource | null = null;
    let sb: SourceBuffer | null = null;
    const listeners: (() => void)[] = [];
    const on = (target: EventTarget, type: string, handler: () => void, options?: AddEventListenerOptions): void => {
      target.addEventListener(type, handler, options);
      listeners.push(() => target.removeEventListener(type, handler));
    };
    teardown = () => {
      pump?.dispose();
      for (const off of listeners) off();
      try {
        if (ms?.readyState === 'open') ms.endOfStream();
        if (ms && sb) ms.removeSourceBuffer(sb);
      } catch {
        // すでに閉じている
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (url) URL.revokeObjectURL(url);
      input.dispose();
    };

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      const audioTrack = await input.getPrimaryAudioTrack();
      const reason = checkPlayable(await probeTrack(videoTrack), await probeTrack(audioTrack));
      if (reason || !videoTrack) return fail(reason ?? '映像トラックがありません');
      const videoCodec = (await videoTrack.getCodec())!;
      const audioCodec = audioTrack ? (await audioTrack.getCodec())! : null;
      const videoConfig = (await videoTrack.getDecoderConfig())!;
      const audioConfig = audioTrack ? (await audioTrack.getDecoderConfig())! : null;

      const mime = buildMp4Mime((await videoTrack.getCodecParameterString())!, audioTrack ? (await audioTrack.getCodecParameterString())! : null);
      if (!Ctor.isTypeSupported(mime)) return fail(`この端末ではこのコーデックを再生できません（${mime}）`);

      // 再生時間はメタデータから（全体を走査する computeDuration は、無いときだけ。遅いので「準備中」のまま待つ）
      const duration = (await input.getDurationFromMetadata()) ?? (await input.computeDuration());
      if (disposed) return;

      // 再生前に、キーフレーム間隔（GOP）から最大フラグメントの大きさを見積もり、三段階で扱う（4.4節）
      const probeSink = new EncodedPacketSink(videoTrack);
      let lastKey: EncodedPacket | null = null;
      const gopSeconds = await probeMaxGopSeconds(
        {
          keyAtOrBefore: async (t) => {
            lastKey = await probeSink.getKeyPacket(t, { metadataOnly: true });
            return lastKey ? lastKey.timestamp : null;
          },
          nextKeyAfter: async () => {
            const next = lastKey ? await probeSink.getNextKeyPacket(lastKey, { metadataOnly: true }) : null;
            return next ? next.timestamp : null;
          },
        },
        duration,
      );
      if (disposed) return;
      if (gopSeconds !== null) {
        const level = classifyFragmentBytes(estimateFragmentBytes(gopSeconds, file.size, duration));
        if (level === 'refuse') return fail(GOP_REFUSE_MESSAGE);
        if (level === 'warn') callbacks.onWarning(GOP_WARN_MESSAGE);
      }

      const makeOutput: OutputFactory = (events) => {
        const output = new Output({
          format: new Mp4OutputFormat({
            fastStart: 'fragmented',
            minimumFragmentDuration: MIN_FRAGMENT_SECONDS, // 単位は秒
            onMoof: (_data, position, timestamp) => events.onMoof(position, timestamp),
          }),
          target: new AppendOnlyStreamTarget(new WritableStream<Uint8Array>({ write: (chunk) => events.write(chunk) })),
        });
        // パケットSourceは1つの Output にしかつなげられない。Output ごとに新しく作る
        const vSource = new EncodedVideoPacketSource(videoCodec);
        output.addVideoTrack(vSource);
        const aSource = audioCodec ? new EncodedAudioPacketSource(audioCodec) : null;
        if (aSource) output.addAudioTrack(aSource);
        return {
          start: () => output.start(),
          add: (kind, packet, first) =>
            kind === 'video'
              ? vSource.add(packet.raw as EncodedPacket, first ? { decoderConfig: videoConfig } : undefined)
              : aSource!.add(packet.raw as EncodedPacket, first && audioConfig ? { decoderConfig: audioConfig } : undefined),
          finalize: () => output.finalize(),
          cancel: () => output.cancel(),
        };
      };

      ms = new Ctor();
      const managed = ms as ManagedMediaSource;
      video.playsInline = true;
      video.preservesPitch = true;
      video.disableRemotePlayback = true; // iPhone Safari では、これが無いと sourceopen が発火しない
      video.defaultPlaybackRate = 1;
      const mediaSource = ms;
      on(
        mediaSource,
        'sourceopen',
        () => {
          if (disposed) return;
          try {
            sb = mediaSource.addSourceBuffer(mime);
            mediaSource.duration = duration;
            const buffer = sb;
            const queue = new SourceBufferQueue(
              {
                appendBuffer: (data) => buffer.appendBuffer(data as BufferSource),
                remove: (start, end) => buffer.remove(start, end),
                abort: () => buffer.abort(),
                get updating() {
                  return buffer.updating;
                },
                addEventListener: (type, handler) => buffer.addEventListener(type, handler),
                removeEventListener: (type, handler) => buffer.removeEventListener(type, handler),
              },
              mediaSource,
            );
            pump = new PacketPump({
              video: trackReader(new EncodedPacketSink(videoTrack)),
              audio: audioTrack ? trackReader(new EncodedPacketSink(audioTrack)) : null,
              makeOutput,
              queue,
              media: mediaSource,
              clock: { currentTime: () => video.currentTime },
              buffered: {
                ranges: () => {
                  const out: { start: number; end: number }[] = [];
                  const b = video.buffered;
                  for (let i = 0; i < b.length; i++) out.push({ start: b.start(i), end: b.end(i) });
                  return out;
                },
                streaming: () => managed.streaming !== false,
              },
              durationSeconds: duration,
              callbacks: { onFatal: fail, onWarning: callbacks.onWarning },
            });
            const p = pump;
            const notify = (): void => p.notify();
            on(video, 'timeupdate', notify);
            on(video, 'waiting', notify);
            on(video, 'play', notify);
            on(video, 'ratechange', notify);
            on(video, 'seeking', () => p.onSeeking());
            on(mediaSource, 'startstreaming', notify);
            on(buffer, 'updateend', notify);
            on(buffer, 'bufferedchange', () => p.onBufferedChange());
            diag = () => p.diagnostics();
            p.start(0);
          } catch (e) {
            fail(`再生の準備に失敗しました（${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}）`);
          }
        },
        { once: true },
      );
      on(video, 'error', () => fail(describeMediaError(video)));
      on(video, 'loadedmetadata', () => callbacks.onReady(), { once: true });
      url = URL.createObjectURL(mediaSource);
      video.src = url;
      video.playbackRate = 1;
    } catch (e) {
      fail(`MKVを読み込めませんでした（${e instanceof Error ? e.message : String(e)}）`);
    }
  })();

  return {
    dispose(): void {
      disposed = true;
      teardown?.();
      teardown = null;
    },
    diagnostics: () => diag(),
  };
}
