import { describe, expect, test } from 'vitest';
import { GOP_REFUSE_BYTES, GOP_WARN_BYTES, SOURCEBUFFER_BUDGET_BYTES } from '../../src/limits';
import {
  backRemovalEnd,
  containingRange,
  findGap,
  forwardSeconds,
  FragmentLedger,
  isInBuffer,
  residentBytes,
} from '../../src/media/bufferAccounting';
import { buildMp4Mime, checkPlayable, toMp4CodecString } from '../../src/media/codecString';
import { classifyFragmentBytes, estimateFragmentBytes, probeMaxGopSeconds } from '../../src/media/gopPolicy';
import {
  budgetDecision,
  chooseTrack,
  shouldRotate,
  shouldWaitForFlow,
  splitSlices,
} from '../../src/media/pumpPolicy';
import { SourceBufferQueue } from '../../src/media/sourceBufferQueue';
import { FakeMediaSource, FakeSourceBuffer, sleep } from './fakes';

const MiB = 1024 * 1024;

describe('codecString', () => {
  test('MP4内の Opus は先頭大文字（iPhone の isTypeSupported は小文字を偽にする）', () => {
    expect(toMp4CodecString('opus')).toBe('Opus');
    expect(toMp4CodecString('Opus')).toBe('Opus');
    expect(toMp4CodecString('mp4a.40.2')).toBe('mp4a.40.2');
    expect(buildMp4Mime('vp09.00.10.08', 'opus')).toBe('video/mp4; codecs="vp09.00.10.08, Opus"');
  });

  test('音声が無ければ映像だけの codecs にする', () => {
    expect(buildMp4Mime('avc1.640028', null)).toBe('video/mp4; codecs="avc1.640028"');
  });

  test('コーデック名・decoderConfig が取れないトラックは再生不可。音声が無いのは問題ない', () => {
    const ok = { codec: 'vp9', codecString: 'vp09', hasDecoderConfig: true };
    expect(checkPlayable(ok, null)).toBeNull();
    expect(checkPlayable(ok, { codec: 'opus', codecString: 'opus', hasDecoderConfig: true })).toBeNull();
    expect(checkPlayable(null, null)).toContain('映像トラック');
    expect(checkPlayable({ ...ok, codec: null }, null)).toContain('映像');
    expect(checkPlayable({ ...ok, hasDecoderConfig: false }, null)).toContain('映像');
    expect(checkPlayable(ok, { codec: null, codecString: null, hasDecoderConfig: false })).toContain('音声');
    expect(checkPlayable(ok, { codec: 'aac', codecString: 'mp4a.40.2', hasDecoderConfig: false })).toContain('音声');
  });
});

describe('gopPolicy', () => {
  test('境界値：24MiB以下は通常、24〜40MiBは警告、40MiB超は断る', () => {
    expect(classifyFragmentBytes(GOP_WARN_BYTES)).toBe('normal');
    expect(classifyFragmentBytes(GOP_WARN_BYTES + 1)).toBe('warn');
    expect(classifyFragmentBytes(GOP_REFUSE_BYTES)).toBe('warn');
    expect(classifyFragmentBytes(GOP_REFUSE_BYTES + 1)).toBe('refuse');
  });

  test('F＝GOP長×ビットレート（ファイルサイズ÷再生時間）', () => {
    // 20Mbps（2.5MB/s）・GOP 10秒 ≒ 25MB ＝ 23.8MiB → 通常（実機で最後まで再生できた）
    const bytesPerSec = 2_500_000;
    const f = estimateFragmentBytes(10, bytesPerSec * 3600, 3600);
    expect(f).toBeCloseTo(25_000_000);
    expect(classifyFragmentBytes(f)).toBe('normal');
    expect(classifyFragmentBytes(estimateFragmentBytes(30, bytesPerSec * 100, 100))).toBe('refuse'); // 75MB
    expect(estimateFragmentBytes(5, 100, 0)).toBe(0);
  });

  test('3か所の最大の間隔を返す。最初の測定が間に合わなければ残りを省いて null', async () => {
    const keys = new Map([[10, 10], [50, 50], [90, 90]]);
    const gaps = new Map([[10, 4], [50, 12], [90, 7]]);
    const fake = {
      keyAtOrBefore: async (t: number) => keys.get(Math.round(t)) ?? null,
      nextKeyAfter: async (k: number) => k + (gaps.get(k) ?? 0),
    };
    expect(await probeMaxGopSeconds(fake, 100, 100)).toBe(12);

    let calls = 0;
    const slow = {
      keyAtOrBefore: () => {
        calls++;
        return new Promise<number | null>(() => undefined); // 返ってこない（Cuesが無く先頭から走査している）
      },
      nextKeyAfter: async () => null,
    };
    expect(await probeMaxGopSeconds(slow, 100, 20)).toBeNull();
    expect(calls).toBe(1);
  });

  test('キーフレームが見つからない・次が無い測定は無視する', async () => {
    const fake = { keyAtOrBefore: async () => null, nextKeyAfter: async () => null };
    expect(await probeMaxGopSeconds(fake, 100, 50)).toBeNull();
  });
});

describe('bufferAccounting', () => {
  const ranges = [
    { start: 0.04, end: 10 },
    { start: 20, end: 30 },
  ];

  test('buffered の先頭が少し後でも、許容誤差内なら区間に含む', () => {
    expect(containingRange(ranges, 0)?.start).toBe(0.04);
    expect(isInBuffer(ranges, 0)).toBe(true);
    expect(isInBuffer(ranges, 15)).toBe(false);
    expect(isInBuffer([{ start: 1, end: 5 }], 0)).toBe(false);
  });

  test('先読み秒数は、t を含む区間の末尾（最後の区間の末尾ではない）− t', () => {
    expect(forwardSeconds(ranges, 4)).toBe(6);
    expect(forwardSeconds(ranges, 25)).toBe(5);
    expect(forwardSeconds(ranges, 15)).toBe(0);
  });

  test('常駐バイト数は buffered と重なる記録の合計（足し引きの累計を持たない）', () => {
    const records = [
      { start: 0, end: 2, bytes: 100 },
      { start: 2, end: 4, bytes: 200 },
      { start: 20, end: 22, bytes: 400 },
      { start: 40, end: 42, bytes: 800 },
    ];
    expect(residentBytes(records, ranges)).toBe(700);
    expect(residentBytes(records, [])).toBe(0);
    // 区間の一部だけ残る記録も1個分として数える
    expect(residentBytes(records, [{ start: 3.9, end: 4.5 }])).toBe(200);
  });

  describe('後方削除の終点', () => {
    const records = [0, 2, 4, 6, 8, 10, 12].map((start) => ({ start, end: start + 2, bytes: 10 }));
    test('currentTime − 秒数 以下で最大のフラグメント開始時刻（キーフレームの位置）', () => {
      expect(backRemovalEnd(records, 17, 15, 0)).toBe(2);
      expect(backRemovalEnd(records, 14.9, 1, 0)).toBe(12);
      expect(backRemovalEnd(records, 13, 1, 0)).toBe(12);
    });
    test('該当が無い・終点が buffered の先頭以下なら削除しない', () => {
      expect(backRemovalEnd(records, 5, 15, 0)).toBeNull();
      expect(backRemovalEnd(records, 17, 15, 2)).toBeNull();
      expect(backRemovalEnd([], 100, 15, 0)).toBeNull();
    });
  });

  describe('隙間の判定', () => {
    test('書き込み位置が区間の末尾より0.5秒を超えて先なら、区間の末尾から供給し直す', () => {
      expect(findGap([{ start: 0, end: 12 }, { start: 20, end: 30 }], 10, 30)).toEqual({ gapStart: 12 });
      expect(findGap([{ start: 0, end: 30 }], 10, 30)).toBeNull();
      expect(findGap([{ start: 0, end: 29.6 }], 10, 30)).toBeNull(); // 許容誤差内
    });
    test('区間の末尾が書き込み位置より先にあるのは隙間ではない（絶対値で比べない）', () => {
      expect(findGap([{ start: 0, end: 40 }], 10, 30)).toBeNull();
    });
    test('currentTime を含む区間が無ければ先読み0として扱い、先頭が少し後でも誤判定しない', () => {
      expect(findGap([], 10, 30)).toEqual({ gapStart: 10 });
      expect(findGap([], 0, 0)).toBeNull();
      expect(findGap([{ start: 0.04, end: 2 }], 0, 2)).toBeNull();
    });
  });

  describe('FragmentLedger', () => {
    test('onMoof の位置差からフラグメントのバイト数を求め、最後は追加済みバイトとの差にする', () => {
      const l = new FragmentLedger();
      l.clear(0);
      l.beginOutput(0);
      l.onMoof(100, 0);
      l.onMoof(1100, 2);
      l.onMoof(3100, 4);
      l.onEmitted(4100);
      l.onAppended(3600);
      expect(l.records()).toEqual([
        { start: 0, end: 2, bytes: 1000 },
        { start: 2, end: 4, bytes: 2000 },
        { start: 4, end: 4, bytes: 500 },
      ]);
      expect(l.maxFragmentBytes()).toBe(2000);
      expect(l.bytesAt(3)).toBe(2000);
    });

    test('書き込み位置：全部追加済みなら、まだ出力されていない次の断片の先頭の時刻。途中なら追加済みの断片の終わり', () => {
      const l = new FragmentLedger();
      l.clear(0);
      l.beginOutput(0);
      l.onMoof(100, 0);
      l.onMoof(1100, 2);
      l.setPendingStart(4);
      l.onEmitted(1100 + 800);
      l.onAppended(1100); // 最初の断片まで追加済み、2つ目はまだ
      expect(l.writePosition()).toBe(2);
      l.onAppended(800);
      expect(l.writePosition()).toBe(4);
    });

    test('ローテーションをまたいでも継ぎ目の記録が連続し、新しい Output の位置は0から数える', () => {
      const l = new FragmentLedger();
      l.clear(0);
      l.beginOutput(0);
      l.onMoof(100, 0);
      l.onEmitted(600);
      l.onAppended(600);
      l.finishOutput(300);
      l.beginOutput(300);
      l.onMoof(100, 300);
      l.onEmitted(400);
      l.onAppended(400);
      expect(l.records()).toEqual([
        { start: 0, end: 300, bytes: 500 },
        { start: 300, end: 300, bytes: 300 },
      ]);
    });

    test('上書きされた古い記録は捨て、rewind すると書き込み位置が戻る', () => {
      const l = new FragmentLedger();
      l.clear(0);
      l.beginOutput(0);
      l.onMoof(0, 0);
      l.onMoof(1000, 2);
      l.onMoof(2000, 4);
      l.onEmitted(3000);
      l.onAppended(3000);
      l.finishOutput(6);
      expect(l.writePosition()).toBe(6);
      l.rewind(2);
      expect(l.writePosition()).toBe(2);
      l.beginOutput(2);
      l.onMoof(0, 2);
      l.onMoof(500, 4);
      l.onEmitted(900);
      l.onAppended(900);
      l.finishOutput(6);
      const starts = l.records().map((r) => r.start);
      expect(starts).toEqual([0, 2, 4]); // 2・4 の古い記録は新しいものに置き換わり、重複しない
      expect(l.records().find((r) => r.start === 2)!.bytes).toBe(500);
    });

    test('prune：バッファの先頭より前に消えた記録を捨てる', () => {
      const l = new FragmentLedger();
      l.clear(0);
      l.beginOutput(0);
      for (let i = 0; i < 5; i++) l.onMoof(i * 100, i * 2);
      l.onEmitted(500);
      l.onAppended(500);
      l.finishOutput(10);
      l.prune([{ start: 5, end: 10 }]);
      expect(l.records().map((r) => r.start)).toEqual([4, 6, 8]);
    });
  });
});

describe('pumpPolicy', () => {
  test('小さいタイムスタンプを先に書く（同時刻は映像が先）', () => {
    expect(chooseTrack({ timestamp: 1 }, { timestamp: 2 })).toBe('video');
    expect(chooseTrack({ timestamp: 3 }, { timestamp: 2 })).toBe('audio');
    expect(chooseTrack({ timestamp: 2 }, { timestamp: 2 })).toBe('video');
    expect(chooseTrack(null, { timestamp: 2 })).toBe('audio');
    expect(chooseTrack({ timestamp: 1 }, null)).toBe('video');
    expect(chooseTrack(null, null)).toBeNull();
  });

  test('ローテーションは映像のキーフレームで、Output の開始から5分以上経ったとき', () => {
    expect(shouldRotate('video', true, 300, 0)).toBe(true);
    expect(shouldRotate('video', true, 299.9, 0)).toBe(false);
    expect(shouldRotate('video', false, 400, 0)).toBe(false);
    expect(shouldRotate('audio', true, 400, 0)).toBe(false);
    expect(shouldRotate('video', true, 650, 300)).toBe(true);
  });

  test('流量制御：キューが詰まっている・先読み30秒以上で待つ。endstreaming でも先読み2秒未満なら供給する', () => {
    const base = { streaming: true, forwardSeconds: 5, queueBusy: false };
    expect(shouldWaitForFlow(base)).toBe(false);
    expect(shouldWaitForFlow({ ...base, queueBusy: true })).toBe(true);
    expect(shouldWaitForFlow({ ...base, forwardSeconds: 30 })).toBe(true);
    expect(shouldWaitForFlow({ ...base, streaming: false })).toBe(true);
    expect(shouldWaitForFlow({ ...base, streaming: false, forwardSeconds: 1.9 })).toBe(false);
  });

  describe('総量待ち', () => {
    const budget = SOURCEBUFFER_BUDGET_BYTES;
    test('入るなら進み、入らなければ待ち、古い分を全部消しても入らないときだけエラー', () => {
      expect(budgetDecision({ resident: 10 * MiB, pending: 20 * MiB, budget, playingFragmentBytes: 5 * MiB })).toBe('go');
      expect(budgetDecision({ resident: 70 * MiB, pending: 20 * MiB, budget, playingFragmentBytes: 5 * MiB })).toBe('wait');
      expect(budgetDecision({ resident: 70 * MiB, pending: 50 * MiB, budget, playingFragmentBytes: 40 * MiB })).toBe('unsatisfiable');
    });
    test('0.5倍速の20Mbps・GOP 10秒（約24MiB）／15秒（約36MiB）を、待っても解けないと誤判定しない', () => {
      // 常駐が予算いっぱいでも、再生中の断片＋pending は予算内なので「待つ」（時間切れでエラーにしない）
      for (const f of [24 * MiB, 36 * MiB]) {
        const d = budgetDecision({ resident: budget, pending: f, budget, playingFragmentBytes: f });
        expect(d).toBe('wait');
      }
    });
    test('予算を半分にした後は、F＝40MiB だと解けない', () => {
      expect(budgetDecision({ resident: 0, pending: 40 * MiB, budget: budget / 2 - 1, playingFragmentBytes: 40 * MiB })).toBe('unsatisfiable');
    });
  });

  test('チャンクの4MiB分割：境界・端数・ちょうど', () => {
    const S = 4 * MiB;
    expect(splitSlices(0, S)).toEqual([]);
    expect(splitSlices(1, S)).toEqual([[0, 1]]);
    expect(splitSlices(S, S)).toEqual([[0, S]]);
    expect(splitSlices(S + 1, S)).toEqual([[0, S], [S, S + 1]]);
    expect(splitSlices(2 * S + 5, S)).toEqual([[0, S], [S, 2 * S], [2 * S, 2 * S + 5]]);
  });
});

describe('SourceBufferQueue', () => {
  function setup() {
    const ms = new FakeMediaSource();
    const sb = new FakeSourceBuffer(ms);
    return { ms, sb, queue: new SourceBufferQueue(sb, ms) };
  }

  test('操作を1つずつ、updateend を待って直列に実行する（updating 中に次を発行しない）', async () => {
    const { sb, queue } = setup();
    sb.delayMs = 5;
    const order: string[] = [];
    await Promise.all([
      queue.append(new Uint8Array(10)).then(() => order.push('a1')),
      queue.remove(0, 1).then(() => order.push('r')),
      queue.append(new Uint8Array(10)).then(() => order.push('a2')),
    ]);
    expect(order).toEqual(['a1', 'r', 'a2']);
    expect(queue.pending).toBe(0);
  });

  test('QuotaExceededError は reject する。次の操作は影響を受けない', async () => {
    const { sb, queue } = setup();
    sb.failNext = 1;
    await expect(queue.append(new Uint8Array(10))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    await expect(queue.append(new Uint8Array(10))).resolves.toBeUndefined();
  });

  test('discardPending は未実行の操作を実行せず、Promise を必ず解決する。実行中の操作は終わるまで待つ', async () => {
    const { sb, queue } = setup();
    sb.delayMs = 10;
    const ran: string[] = [];
    const first = queue.enqueue(async (io) => {
      await io.append(new Uint8Array(1));
      ran.push('first');
      return 'done';
    }, 'discarded');
    const second = queue.enqueue(async () => {
      ran.push('second');
      return 'done';
    }, 'discarded');
    await sleep(2);
    queue.discardPending();
    expect(await first).toBe('done');
    expect(await second).toBe('discarded');
    expect(ran).toEqual(['first']);
    // 破棄の後に積んだ操作は実行される
    expect(await queue.enqueue(async () => 'later', 'discarded')).toBe('later');
  });

  test('abort は open のときだけ SourceBuffer.abort を呼ぶ（ended では InvalidStateError になる）', async () => {
    const { ms, sb, queue } = setup();
    await queue.abort();
    expect(sb.aborts).toBe(1);
    ms.endOfStream();
    await queue.abort();
    expect(sb.aborts).toBe(1);
  });

  test('ended のとき remove は open に戻す。endOfStream は open のときだけ呼ぶ', async () => {
    const { ms, queue } = setup();
    await queue.endOfStream();
    await queue.endOfStream();
    expect(ms.endOfStreamCalls).toBe(1);
    await queue.remove(0, Infinity);
    expect(ms.readyState).toBe('open');
  });

  test('remove の実行中に積んだ操作は、updateend の後に実行する', async () => {
    const { sb, queue } = setup();
    sb.delayMs = 10;
    const r = queue.remove(0, Infinity);
    await sleep(2);
    expect(sb.updating).toBe(true);
    const a = queue.append(new Uint8Array(4));
    await Promise.all([r, a]);
    expect(sb.appends).toEqual([4]);
  });
});
