import { describe, expect, test } from 'vitest';
import { ChatStoreBuilder, decodeMessage } from '../../src/chat/chatStore';
import { detectChatFormat } from '../../src/chat/detect';
import { parseChatFile } from '../../src/chat/parseChat';
import { ChatSync, indexAtOrBefore } from '../../src/chat/sync';
import type { ChatMessage, ChatStore } from '../../src/chat/types';
import { blobOf, twitchComment, twitchFile, youtubeLine, ytRenderer } from './helpers';

function msg(t: number, text = `m${t}`, over: Partial<ChatMessage> = {}): ChatMessage {
  return { timeSeconds: t, author: 'a', isOwner: false, isModerator: false, runs: [{ kind: 'text', text }], ...over };
}

function build(messages: ChatMessage[], options = {}): ChatStore {
  const b = new ChatStoreBuilder(options);
  for (const m of messages) b.add(m);
  return b.build();
}

describe('ChatStore', () => {
  test('エンコード→デコードの往復（フラグ・日本語・絵文字・空のrun）', () => {
    const messages: ChatMessage[] = [
      msg(0, 'こんにちは😀', { author: '投稿者', isOwner: true }),
      msg(5, 'x', { isModerator: true, runs: [{ kind: 'text', text: 'a' }, { kind: 'emoji', url: 'u1', alt: 'k' }, { kind: 'emoji', url: 'u1', alt: 'k' }] }),
      msg(5, 'y', { runs: [] }),
      msg(9, 'z'.repeat(300)),
    ];
    const store = build(messages);
    expect(store.emojis).toEqual([{ url: 'u1', alt: 'k' }]); // 重複排除
    expect(messages.map((_, i) => decodeMessage(store, i))).toEqual(messages);
  });

  test('チャンクの切れ目をまたぐ位置でも往復できる（小さいチャンクで）', () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg(i, `message-${i}-${'x'.repeat(i % 17)}`));
    const store = build(messages, { chunkBytes: 100, indexChunkItems: 7 });
    expect(store.records.length).toBeGreaterThan(10);
    expect(store.records.every((r, i) => i === store.records.length - 1 || r.length === 100)).toBe(true);
    for (let i = 0; i < messages.length; i++) {
      const off = store.offsets[i]!;
      // レコードはチャンクをまたがない
      expect(off % 100).toBeLessThan(100);
      expect(decodeMessage(store, i)).toEqual(messages[i]);
    }
  });

  test('チャンクに入らない巨大なレコードは捨てる', () => {
    const b = new ChatStoreBuilder({ chunkBytes: 64 });
    expect(b.add(msg(1, 'x'.repeat(100)))).toBe(false);
    expect(b.add(msg(2, 'ok'))).toBe(true);
    expect(b.build().times).toEqual(new Uint32Array([2]));
  });

  test('昇順でない入力は安定ソートされ、records が詰め直されても全件が正しく復号できる', () => {
    const input = [msg(30, 'c1'), msg(10, 'a1'), msg(30, 'c2'), msg(10, 'a2'), msg(20, 'b1'), msg(10, 'a3')];
    const store = build(input, { chunkBytes: 50 });
    expect(Array.from(store.times)).toEqual([10, 10, 10, 20, 30, 30]);
    const texts = input.map((_, i) => (decodeMessage(store, i).runs[0] as { text: string }).text);
    expect(texts).toEqual(['a1', 'a2', 'a3', 'b1', 'c1', 'c2']); // 同じ秒はファイル順
  });

  test('小数・負の時刻は切り捨て・0に丸める', () => {
    const store = build([msg(1.9), msg(-3)]);
    expect(Array.from(store.times)).toEqual([1, 0].sort((a, b) => a - b));
  });
});

describe('indexAtOrBefore', () => {
  const times = new Uint32Array([2, 5, 5, 5, 9]);
  test.each([
    [0, -1],
    [1, -1],
    [2, 0],
    [4, 0],
    [5, 3],
    [8, 3],
    [9, 4],
    [100, 4],
  ])('t=%i → %i', (t, expected) => {
    expect(indexAtOrBefore(times, t)).toBe(expected);
  });

  test('空配列は -1', () => {
    expect(indexAtOrBefore(new Uint32Array(0), 3)).toBe(-1);
  });
});

describe('ChatSync', () => {
  const store = build(Array.from({ length: 1000 }, (_, i) => msg(i)));
  const texts = (a: { messages: ChatMessage[] }) => a.messages.map((m) => m.timeSeconds);

  test('ストア未設定・空のストアは何もしない', () => {
    const s = new ChatSync();
    expect(s.update(5)).toEqual({ type: 'none' });
    s.setStore(build([]));
    expect(s.update(5)).toEqual({ type: 'none' });
  });

  test('先頭のメッセージより前は、空にして lastIndex を -1 に戻す（2回目は何もしない）', () => {
    const s = new ChatSync();
    s.setStore(build([msg(10), msg(20)]));
    expect(s.update(5)).toEqual({ type: 'none' }); // もともと -1
    expect(s.update(15).type).toBe('append');
    expect(s.update(5)).toEqual({ type: 'reset', messages: [] });
    expect(s.update(6)).toEqual({ type: 'none' });
  });

  test('前進は差分の追加、同じ位置は何もしない、後退は作り直し', () => {
    const s = new ChatSync();
    s.setStore(store);
    const first = s.update(2);
    expect(first.type).toBe('append');
    expect(texts(first as { messages: ChatMessage[] })).toEqual([0, 1, 2]);
    expect(s.update(2.9)).toEqual({ type: 'none' });
    const next = s.update(4);
    expect(texts(next as { messages: ChatMessage[] })).toEqual([3, 4]);
    const back = s.update(1);
    expect(back.type).toBe('reset');
    expect(texts(back as { messages: ChatMessage[] })).toEqual([0, 1]);
  });

  test('前進でも差分が200件を超えるときは、最新200件で作り直す', () => {
    const s = new ChatSync();
    s.setStore(store);
    s.update(10);
    const jump = s.update(500);
    expect(jump.type).toBe('reset');
    const t = texts(jump as { messages: ChatMessage[] });
    expect(t).toHaveLength(200);
    expect(t[0]).toBe(301);
    expect(t[199]).toBe(500);
    // ちょうど200件の差分は追加のまま
    expect(s.update(700).type).toBe('append');
  });

  test('シーク時の再構築は最大200件', () => {
    const s = new ChatSync();
    s.setStore(store);
    s.update(900);
    const back = s.update(600);
    expect(texts(back as { messages: ChatMessage[] })).toHaveLength(200);
  });

  test('setStore の直後は現在位置へ追従する（解析完了時）', () => {
    const s = new ChatSync();
    s.setStore(store);
    s.update(50);
    s.setStore(store);
    const r = s.update(50);
    expect(r.type).toBe('append');
    expect(texts(r as { messages: ChatMessage[] })).toHaveLength(51);
  });
});

describe('形式判定と parseChatFile', () => {
  test('replayChatItemAction が先頭4096バイトにあれば YouTube', async () => {
    expect(await detectChatFormat(blobOf(youtubeLine(ytRenderer())))).toBe('youtube');
    expect(await detectChatFormat(blobOf(twitchFile([])))).toBe('twitch');
  });

  test('BOM付きでも判定でき、4096バイトの境界にまたがるキーは見つけない', async () => {
    const key = '"replayChatItemAction"';
    expect(await detectChatFormat(blobOf('﻿' + youtubeLine(ytRenderer())))).toBe('youtube');
    const fits = 'x'.repeat(4096 - key.length) + key;
    expect(await detectChatFormat(blobOf(fits))).toBe('youtube');
    const over = 'x'.repeat(4096 - key.length + 1) + key;
    expect(await detectChatFormat(blobOf(over))).toBe('twitch');
    const straddle = 'x'.repeat(4096 - 5) + key;
    expect(await detectChatFormat(blobOf(straddle))).toBe('twitch');
  });

  test('両形式の同じ内容のテキストのみのチャットは同じ ChatStore になる', async () => {
    const yt = [
      youtubeLine(ytRenderer({ timestampText: { simpleText: '0:10' }, authorName: { simpleText: 'A' }, message: { runs: [{ text: 'one' }] } })),
      youtubeLine(ytRenderer({ timestampText: { simpleText: '0:20' }, authorName: { simpleText: 'B' }, message: { runs: [{ text: 'two' }] } })),
    ].join('\n');
    const tw = twitchFile(
      [
        twitchComment({ content_offset_seconds: 10.5, commenter: { display_name: 'A' }, message: { body: 'one', fragments: [{ text: 'one' }] } }),
        twitchComment({ content_offset_seconds: 20, commenter: { display_name: 'B' }, message: { body: 'two', fragments: [{ text: 'two' }] } }),
      ],
    );
    const a = await parseChatFile(blobOf(yt));
    const b = await parseChatFile(blobOf(tw));
    expect(b).toEqual(a);
  });

  test('進捗が呼ばれ、昇順でない Twitch が整列される', async () => {
    const comments = Array.from({ length: 5000 }, (_, i) => twitchComment({ content_offset_seconds: (i * 7919) % 5000 }));
    const seen: number[] = [];
    const store = await parseChatFile(blobOf(twitchFile(comments)), { onProgress: (n) => seen.push(n) });
    expect(seen.length).toBeGreaterThan(0);
    expect(store.times).toHaveLength(5000);
    for (let i = 1; i < store.times.length; i++) expect(store.times[i]!).toBeGreaterThanOrEqual(store.times[i - 1]!);
  });
});
