import { describe, expect, test } from 'vitest';
import { EmojiImageCache, type EmojiSource } from '../../src/emoji/emojiImageCache';
import { LatestOnly } from '../../src/ui/latestOnly';

function setup(options: { maxItems?: number; maxBytes?: number } = {}) {
  const created: string[] = [];
  const revoked: string[] = [];
  let counter = 0;
  const cache = new EmojiImageCache({
    ...options,
    createObjectUrl: () => {
      const u = `blob:${counter++}`;
      created.push(u);
      return u;
    },
    revokeObjectUrl: (u) => revoked.push(u),
  });
  return { cache, created, revoked };
}

function source(sizes: Record<string, number>, calls: string[] = []): EmojiSource {
  return {
    get: async (url) => {
      calls.push(url);
      const size = sizes[url];
      return size === undefined ? null : new Blob([new Uint8Array(size)]);
    },
  };
}

describe('EmojiImageCache', () => {
  test('読み込んだURLを返し、2回目はsqliteを引かない', async () => {
    const { cache } = setup();
    const calls: string[] = [];
    cache.setSource(source({ a: 10 }, calls));
    const first = await cache.getOrLoad('a');
    expect(first).toBe('blob:0');
    expect(await cache.getOrLoad('a')).toBe('blob:0');
    expect(calls).toEqual(['a']);
  });

  test('sqliteが無い・見つからない・空URLは null', async () => {
    const { cache } = setup();
    expect(await cache.getOrLoad('a')).toBeNull();
    cache.setSource(source({}));
    expect(await cache.getOrLoad('a')).toBeNull();
    expect(await cache.getOrLoad('')).toBeNull();
  });

  test('件数の上限で追い出し、追い出したURLを revoke する（LRU：参照すると延命）', async () => {
    const { cache, revoked } = setup({ maxItems: 2 });
    cache.setSource(source({ a: 1, b: 1, c: 1 }));
    await cache.getOrLoad('a');
    await cache.getOrLoad('b');
    await cache.getOrLoad('a'); // a を最新にする
    await cache.getOrLoad('c'); // b が追い出される
    expect(revoked).toEqual(['blob:1']);
    expect(cache.size).toBe(2);
  });

  test('合計バイトの上限でも追い出す（件数は余っていても）', async () => {
    const { cache, revoked } = setup({ maxItems: 100, maxBytes: 100 });
    cache.setSource(source({ a: 60, b: 60, c: 30 }));
    await cache.getOrLoad('a');
    await cache.getOrLoad('b'); // 120 > 100 → a を追い出す
    expect(revoked).toEqual(['blob:0']);
    expect(cache.bytes).toBe(60);
    await cache.getOrLoad('c');
    expect(cache.bytes).toBe(90);
  });

  test('同じURLの同時の読み込みは1回の取得に合流する', async () => {
    const { cache, created } = setup();
    const calls: string[] = [];
    cache.setSource(source({ a: 5 }, calls));
    const results = await Promise.all([cache.getOrLoad('a'), cache.getOrLoad('a'), cache.getOrLoad('a')]);
    expect(results).toEqual(['blob:0', 'blob:0', 'blob:0']);
    expect(calls).toEqual(['a']);
    expect(created).toHaveLength(1);
  });

  test('取得に失敗しても inFlight から消え、次は再取得できる', async () => {
    const { cache } = setup();
    let fail = true;
    cache.setSource({
      get: async () => {
        if (fail) throw new Error('boom');
        return new Blob([new Uint8Array(3)]);
      },
    });
    expect(await cache.getOrLoad('a')).toBeNull();
    fail = false;
    expect(await cache.getOrLoad('a')).toBe('blob:0');
  });

  test('clear は全件を revoke し、読み込み中だった結果は捨てる（URLを作らない）', async () => {
    const { cache, created, revoked } = setup();
    let release!: (b: Blob) => void;
    cache.setSource({
      get: (url) =>
        url === 'slow' ? new Promise<Blob>((r) => (release = r)) : Promise.resolve(new Blob([new Uint8Array(1)])),
    });
    await cache.getOrLoad('a');
    await cache.getOrLoad('b');
    const slow = cache.getOrLoad('slow');
    cache.clear();
    expect(revoked.sort()).toEqual(['blob:0', 'blob:1']);
    release(new Blob([new Uint8Array(1)]));
    expect(await slow).toBeNull();
    expect(created).toHaveLength(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('LatestOnly（古い取得結果を捨てる世代番号）', () => {
  test('作り直し（advance）の前に取った token は無効になる', async () => {
    const guard = new LatestOnly();
    const applied: string[] = [];
    const load = async (name: string, delay: Promise<void>): Promise<void> => {
      const token = guard.token();
      await delay;
      if (guard.isCurrent(token)) applied.push(name);
    };
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const old = load('old', gate);
    guard.advance();
    const fresh = load('new', Promise.resolve());
    open();
    await Promise.all([old, fresh]);
    expect(applied).toEqual(['new']);
  });
});
