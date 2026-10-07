import { afterEach, describe, expect, test } from 'vitest';
import { APPEND_SLICE_BYTES, SEEK_DEBOUNCE_MS } from '../../src/limits';
import { GOP_REFUSE_MESSAGE, GOP_WARN_MESSAGE } from '../../src/media/gopPolicy';
import { PacketPump } from '../../src/media/packetPump';
import { SourceBufferQueue } from '../../src/media/sourceBufferQueue';
import {
  FakeMedia,
  FakeMediaSource,
  FakeOutputFactory,
  FakeSourceBuffer,
  sleep,
  until,
  type FakeMediaOptions,
} from './fakes';

const MiB = 1024 * 1024;

function harness(options: FakeMediaOptions) {
  const media = new FakeMedia(options);
  const ms = new FakeMediaSource();
  const sb = new FakeSourceBuffer(ms);
  const queue = new SourceBufferQueue(sb, ms);
  const factory = new FakeOutputFactory();
  const clock = {
    t: 0,
    currentTime(): number {
      return this.t;
    },
  };
  const fatal: string[] = [];
  const warnings: string[] = [];
  const pump = new PacketPump({
    video: media.reader(media.video),
    audio: media.hasAudio ? media.reader(media.audio) : null,
    makeOutput: factory.make,
    queue,
    media: ms,
    clock,
    buffered: { ranges: () => sb.ranges(), streaming: () => ms.streaming },
    durationSeconds: options.duration,
    callbacks: { onFatal: (m) => fatal.push(m), onWarning: (m) => warnings.push(m) },
  });
  sb.bufferedChangeListeners.add(() => pump.onBufferedChange());
  sb.addEventListener('updateend', () => pump.notify());
  return { media, ms, sb, queue, factory, clock, fatal, warnings, pump };
}

const pumps: { dispose(): void }[] = [];
afterEach(() => {
  for (const p of pumps.splice(0)) p.dispose();
});

function start(options: FakeMediaOptions) {
  const h = harness(options);
  pumps.push(h.pump);
  h.pump.start(0);
  return h;
}

function endOf(h: ReturnType<typeof harness>): number {
  const r = h.sb.ranges();
  return r.length ? r[r.length - 1]!.end : 0;
}

describe('PacketPump：基本', () => {
  test('最後まで書き、パケットが欠けず・重複せず、endOfStream する（先頭の負の時刻の音声は書かない）', async () => {
    const h = start({ duration: 20 });
    await until(() => h.ms.endOfStreamCalls === 1, 3000, 'endOfStream');
    const ids = h.factory.log.outputs.flat();
    expect(new Set(ids).size).toBe(ids.length);
    const expected = [...h.media.video, ...h.media.audio.filter((a) => a.timestamp >= 0)].map((p) => p.id);
    expect([...ids].sort()).toEqual([...expected].sort());
    // タイムスタンプの小さい順（同時刻は映像が先）に書かれる
    const byId = new Map([...h.media.video, ...h.media.audio].map((p) => [p.id, p]));
    const times = ids.map((id) => byId.get(id)!.timestamp);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(h.factory.log.finalized).toBe(1);
    expect(h.sb.ranges()).toEqual([{ start: 0, end: expect.any(Number) }]);
    expect(h.fatal).toEqual([]);
  });

  test('先読みが30秒に達したら止まり、再生位置が進むと続き、後方を削除する', async () => {
    const h = start({ duration: 120 });
    await until(() => endOf(h) >= 30, 3000, '先読み30秒');
    await sleep(40);
    expect(endOf(h)).toBeLessThan(40);
    expect(h.ms.endOfStreamCalls).toBe(0);
    h.clock.t = 50;
    h.pump.notify();
    await until(() => endOf(h) >= 80, 3000, '再生位置に合わせた続き');
    expect(h.sb.removes.length).toBeGreaterThan(0);
    // 削除の終点はフラグメントの開始時刻（偶数秒）で、再生位置の15秒前以下
    for (const [, end] of h.sb.removes) expect(end).toBeLessThanOrEqual(35);
    expect(h.sb.ranges()[0]!.start).toBeGreaterThan(0);
  });

  test('映像の最初のキーフレームが開始位置より後なら、最初のキーフレームから始める', async () => {
    const h = start({ duration: 10, videoStart: 1 });
    await until(() => h.ms.endOfStreamCalls === 1);
    expect(h.factory.log.outputs[0]![0]).toBe('v0');
  });

  test('音声トラックが無くても最後まで書ける', async () => {
    const h = start({ duration: 10, audioInterval: null });
    await until(() => h.ms.endOfStreamCalls === 1);
    expect(h.factory.log.outputs.flat().every((id) => id.startsWith('v'))).toBe(true);
  });

  test('endstreaming 中でも、先読みが2秒未満なら供給する。足りたら止まる', async () => {
    const h = harness({ duration: 120 });
    pumps.push(h.pump);
    h.ms.streaming = false;
    h.pump.start(0);
    await until(() => endOf(h) >= 2, 3000, '2秒の先読み');
    await sleep(40);
    expect(endOf(h)).toBeLessThan(10);
    h.ms.streaming = true;
    h.pump.notify();
    await until(() => endOf(h) >= 30, 3000, 'streaming 再開');
  });

  test('buffered の先頭が0より少し後でも、隙間の再供給を起こさない', async () => {
    const h = start({ duration: 10, videoStart: 0.04 });
    await until(() => h.ms.endOfStreamCalls === 1);
    expect(h.factory.log.started).toBe(1);
  });

  test('endOfStream の後は、再生位置が進んでも後方を削除しない', async () => {
    const h = start({ duration: 20 });
    await until(() => h.ms.endOfStreamCalls === 1);
    const before = h.sb.removes.length;
    h.clock.t = 19;
    h.pump.notify();
    await sleep(30);
    expect(h.sb.removes.length).toBe(before);
    expect(h.ms.readyState).toBe('ended');
  });
});

describe('PacketPump：チャンクの分割・Quota・上限', () => {
  test('出力チャンクは4MiB以下に分けて追加する（境界・端数）', async () => {
    const h = start({ duration: 6, packetBytes: 3 * MiB });
    await until(() => h.ms.endOfStreamCalls === 1, 8000, 'endOfStream');
    expect(h.sb.appends.every((n) => n <= APPEND_SLICE_BYTES)).toBe(true);
    expect(h.sb.appends.filter((n) => n === APPEND_SLICE_BYTES).length).toBeGreaterThan(0);
    // 先頭の ftyp 以外の合計は、書いた全バイト（3MiB×パケット数＋ヘッダ）に一致
    const total = h.sb.appends.reduce((a, b) => a + b, 0);
    const videoBytes = h.media.video.length * 3 * MiB;
    expect(total).toBeGreaterThanOrEqual(videoBytes);
  });

  test('QuotaExceededError は、予算を半分にして再試行し、再生を続ける', async () => {
    const h = harness({ duration: 20 });
    pumps.push(h.pump);
    h.sb.failNext = 2;
    h.pump.start(0);
    await until(() => h.ms.endOfStreamCalls === 1, 3000);
    expect(h.fatal).toEqual([]);
    expect(h.pump.diagnostics()).toContain('quota=1');
    expect(h.pump.diagnostics()).toContain('budget=40MB');
  });

  test('QuotaExceededError が続くときは、再試行の回数で止めてエラーにする（無限に繰り返さない）', async () => {
    const h = harness({ duration: 20 });
    pumps.push(h.pump);
    h.sb.failNext = 1000;
    h.pump.start(0);
    await until(() => h.fatal.length === 1, 3000, '致命的エラー');
    expect(h.fatal[0]).toContain('メモリ不足');
    expect(h.ms.endOfStreamCalls).toBe(0);
    await sleep(30);
    expect(h.fatal).toHaveLength(1);
  });

  test('Quota のとき、キューの中で後方を直接削除してから再試行し、それでも超えるなら予算を半分にして続ける', async () => {
    const h = start({ duration: 150 });
    await until(() => endOf(h) >= 30, 3000, '先読み30秒');
    await sleep(20);
    h.clock.t = 28; // 後方15秒より前（約13秒まで）は削除できる
    h.sb.failNext = 2;
    h.pump.notify();
    await until(() => endOf(h) >= 45, 3000, '再試行して続き');
    expect(h.fatal).toEqual([]);
    expect(h.sb.removes.length).toBeGreaterThan(0);
    expect(h.pump.diagnostics()).toContain('budget=40MB');
  });

  test('キーフレーム間隔が長すぎる（pending が40MiB超）と、Output に溜める前に止めて案内する', async () => {
    const h = start({ duration: 60, gopSeconds: 30, packetBytes: 5 * MiB });
    await until(() => h.fatal.length === 1, 3000);
    expect(h.fatal[0]).toBe(GOP_REFUSE_MESSAGE);
    expect(h.factory.log.outputs[0]!.length).toBeLessThanOrEqual(20);
  });

  test('24MiB を超えると警告を1回だけ出して続ける', async () => {
    const h = start({ duration: 10, gopSeconds: 4, packetBytes: 3.5 * MiB });
    await until(() => h.warnings.length >= 1, 3000);
    await sleep(30);
    expect(h.warnings).toEqual([GOP_WARN_MESSAGE]);
  });
});

describe('PacketPump：Output のローテーション', () => {
  test('メディア時間で5分ごとに Output を作り直し、継ぎ目でパケットが欠けず・重複しない', async () => {
    const h = harness({ duration: 700, videoInterval: 1, gopSeconds: 4, audioInterval: 1 });
    pumps.push(h.pump);
    h.factory.tailPad = 1;
    h.pump.start(0);
    // 再生位置を、バッファの少し手前へ進め続ける
    const timer = setInterval(() => {
      h.clock.t = Math.max(0, endOf(h) - 8);
      h.pump.notify();
    }, 2);
    try {
      await until(() => h.ms.endOfStreamCalls === 1, 25_000, '700秒の供給');
    } finally {
      clearInterval(timer);
    }
    expect(h.factory.log.started).toBe(3);
    expect(h.factory.log.finalized).toBe(3);
    const ids = h.factory.log.outputs.flat();
    expect(new Set(ids).size).toBe(ids.length);
    const expected = h.media.video.length + h.media.audio.filter((a) => a.timestamp >= 0).length;
    expect(ids.length).toBe(expected);
    // 継ぎ目では、新しい Output の先頭が映像のキーフレーム
    for (const output of h.factory.log.outputs.slice(1)) {
      const firstVideo = output.find((id) => id.startsWith('v'))!;
      expect(h.media.video.find((p) => p.id === firstVideo)!.isKey).toBe(true);
    }
    expect(h.fatal).toEqual([]);
  }, 30_000);
});

describe('PacketPump：シークと世代の切替', () => {
  test('バッファ外へのシークの連発は、250ms後に1回だけの世代切替にまとめる', async () => {
    const h = start({ duration: 600 });
    await until(() => endOf(h) >= 30);
    const startedBefore = h.factory.log.started;
    for (const t of [100, 200, 300, 400, 500]) {
      h.clock.t = t;
      h.pump.onSeeking();
      await sleep(5);
    }
    await sleep(SEEK_DEBOUNCE_MS - 100);
    expect(h.factory.log.started).toBe(startedBefore); // まだ切り替えない
    await until(() => h.factory.log.started === startedBefore + 1, 3000, '世代切替');
    await sleep(40);
    expect(h.factory.log.started).toBe(startedBefore + 1);
    // SourceBuffer を空にしてから、500秒以前のキーフレームから供給する
    expect(h.sb.removes.filter(([s, e]) => s === 0 && e === Infinity)).toHaveLength(1);
    expect(h.factory.log.outputs[1]![0]).toBe('v1000');
    await until(() => endOf(h) >= 530, 3000);
  });

  test('バッファ内に戻ったシークは取り消す', async () => {
    const h = start({ duration: 600 });
    await until(() => endOf(h) >= 30);
    const started = h.factory.log.started;
    h.clock.t = 300;
    h.pump.onSeeking();
    h.clock.t = 10;
    h.pump.onSeeking();
    await sleep(SEEK_DEBOUNCE_MS + 80);
    expect(h.factory.log.started).toBe(started);
  });

  test('追い出しで隙間ができたら、その位置から供給し直す（SourceBuffer は空にしない）', async () => {
    const h = start({ duration: 120 });
    await until(() => endOf(h) >= 30);
    await sleep(20);
    h.clock.t = 10;
    const started = h.factory.log.started;
    h.sb.evict(12, 20);
    expect(h.sb.ranges().length).toBe(2);
    await until(() => h.factory.log.started === started + 1, 3000, '再供給');
    await until(() => h.sb.ranges().length === 1, 3000, '隙間が埋まる');
    expect(h.sb.removes.some(([s, e]) => s === 0 && e === Infinity)).toBe(false);
    expect(h.factory.log.outputs[started]![0]).toBe('v24'); // 12秒（キーフレーム）から
  });

  test('ended のあとのシークは abort() を呼ばず、再び最後まで書いて endOfStream する', async () => {
    const h = start({ duration: 20 });
    await until(() => h.ms.endOfStreamCalls === 1);
    const aborts = h.sb.aborts;
    h.sb.segments = []; // UAがすべて追い出した状態
    h.clock.t = 10;
    h.pump.onSeeking();
    await until(() => h.ms.endOfStreamCalls === 2, 3000, '再度 endOfStream');
    expect(h.sb.aborts).toBe(aborts);
    expect(h.fatal).toEqual([]);
  });

  test('世代を切り替えるとき、捨てた write の Promise は解決し、旧 Output の cancel() が終わる', async () => {
    const h = harness({ duration: 600 });
    pumps.push(h.pump);
    h.sb.delayMs = 30; // 追加が遅く、write が積まれたままの状態を作る
    h.pump.start(0);
    await until(() => h.sb.updating, 3000, '追加の実行中');
    h.clock.t = 400;
    h.pump.onSeeking();
    await until(() => h.factory.log.started === 2, 5000, '世代切替');
    await until(() => h.factory.log.cancelled === 1, 3000);
    // cancel() が終わる＝捨てられた write がすべて解決している
    await sleep(100);
    expect(h.fatal).toEqual([]);
  });

  test('dispose すると供給を止め、Output を cancel する', async () => {
    const h = start({ duration: 120 });
    await until(() => endOf(h) >= 30);
    h.pump.dispose();
    expect(h.factory.log.cancelled).toBe(1);
    const n = h.sb.appends.length;
    h.clock.t = 60;
    h.pump.notify();
    await sleep(30);
    expect(h.sb.appends.length).toBe(n);
  });
});
