import { describe, expect, test } from 'vitest';
import { JsonArrayScanner } from '../../src/chat/jsonArrayScanner';
import { collectTwitch, twitchComment, twitchFile } from './helpers';

function scan(text: string, step: number, property = 'comments'): { items: string[]; scanner: JsonArrayScanner } {
  const items: string[] = [];
  const scanner = new JsonArrayScanner(property, (j) => items.push(j));
  for (let i = 0; i < text.length && !scanner.finished; i += step) scanner.push(text.slice(i, i + step));
  return { items, scanner };
}

describe('JsonArrayScanner', () => {
  const tricky = [
    { a: '}{][', b: 'quote \\" and backslash \\\\' },
    { a: '日本語😀', nested: { x: [1, 2, { y: '"' }] } },
    { a: '', n: null },
  ];
  const text = JSON.stringify({ comments: tricky });

  test.each([1, 2, 3, 7, 1000])('文字列内の記号・エスケープ・サロゲートペアを %i 文字ずつの分割でも同じに切り出す', (step) => {
    const { items } = scan(text, step);
    expect(items.map((s) => JSON.parse(s))).toEqual(tricky);
  });

  test('comments 以外の巨大・多様なプロパティを読み飛ばす（スカラー・文字列・入れ子）', () => {
    const t = JSON.stringify({
      embeddedData: null,
      big: 'x'.repeat(5000) + '"',
      n: 12.5,
      flag: true,
      obj: { comments: [{ no: 1 }], deep: [[{ '}': '{' }]] },
      comments: [{ id: 1 }, { id: 2 }],
    });
    for (const step of [1, 5, 4096]) {
      expect(scan(t, step).items).toEqual(['{"id":1}', '{"id":2}']);
    }
  });

  test('comments が閉じたら finished になる', () => {
    const { scanner } = scan('{"comments":[{"a":1}],"tail":' + '"z"'.repeat(3) + '}', 3);
    expect(scanner.finished).toBe(true);
    expect(scanner.malformed).toBe(false);
  });

  test('ルートに comments が無ければ何も出さず終わる', () => {
    const { items, scanner } = scan('{"a":1,"b":[1,2]}', 2);
    expect(items).toEqual([]);
    expect(scanner.finished).toBe(true);
  });

  test('オブジェクト以外の要素は読み飛ばして継続する', () => {
    expect(scan('{"comments":[1,"s",null,[1],{"a":1},true]}', 3).items).toEqual(['{"a":1}']);
  });

  test('配列の中の不正な "}" で止まらなくなる状態にならない', () => {
    const { scanner } = scan('{"comments":[}', 1);
    expect(scanner.finished).toBe(true);
    expect(scanner.malformed).toBe(true);
  });

  test('途中で切れたファイルでも、それまでの要素は返す', () => {
    const { items, scanner } = scan('{"comments":[{"a":1},{"b":', 4);
    expect(items).toEqual(['{"a":1}']);
    expect(scanner.finished).toBe(false);
  });

  test('BOMと空白を許す', () => {
    expect(scan('﻿ \n{ "comments" : [ { "a" : 1 } ] }', 2).items).toEqual(['{ "a" : 1 }']);
  });
});

describe('parseTwitchComment（ファイル経由）', () => {
  test('基本：秒の切り捨て・投稿者・絵文字URL・altを取り出す', async () => {
    const [m] = await collectTwitch(twitchFile([twitchComment()]));
    expect(m).toEqual({
      timeSeconds: 12,
      author: 'Alice',
      isOwner: false,
      isModerator: false,
      runs: [
        { kind: 'text', text: 'hello ' },
        { kind: 'emoji', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', alt: 'Kappa' },
      ],
    });
  });

  test('1バイトずつ読んでも一括読みと同じ結果になる', async () => {
    const text = twitchFile([
      twitchComment({ commenter: { display_name: '日本語😀' } }),
      twitchComment({ content_offset_seconds: 3 }),
    ]);
    expect(await collectTwitch(text, 1)).toEqual(await collectTwitch(text));
    expect(await collectTwitch(text, 7)).toEqual(await collectTwitch(text));
  });

  test('display_name が無ければ name、空文字の display_name はそのまま使う', async () => {
    const r = await collectTwitch(
      twitchFile([
        twitchComment({ commenter: { name: 'login' } }),
        twitchComment({ commenter: { display_name: '', name: 'login' } }),
        twitchComment({ commenter: null }),
      ]),
    );
    expect(r.map((m) => m.author)).toEqual(['login', '', '']);
  });

  test('content_offset_seconds が数値でない・負は捨て、小数は切り捨てる', async () => {
    const r = await collectTwitch(
      twitchFile([
        twitchComment({ content_offset_seconds: '5' }),
        twitchComment({ content_offset_seconds: -1 }),
        twitchComment({ content_offset_seconds: 0.99 }),
        twitchComment({ content_offset_seconds: null }),
      ]),
    );
    expect(r.map((m) => m.timeSeconds)).toEqual([0]);
  });

  test('サブスク通知は除外し、Unicodeの単語境界を考慮する', async () => {
    const body = (b: string) => twitchComment({ message: { body: b, fragments: [{ text: b }] } });
    const r = await collectTwitch(
      twitchFile([
        body('foo subscribed with Prime.'),
        body('foo resubscribed at Tier 1'),
        body('foo is gifting 5 subs'),
        body('foo gifted'),
        body('foo subscribedだ'),
        body('foo subscribed'),
        body('subscribed'),
      ]),
    );
    expect(r.map((m) => (m.runs[0] as { text: string }).text)).toEqual(['foo subscribedだ', 'subscribed']);
  });

  test('バッジはbroadcaster・moderatorの完全一致（大文字小文字を区別）', async () => {
    const badges = (...ids: string[]) =>
      twitchComment({ message: { body: 'x', fragments: [{ text: 'x' }], user_badges: ids.map((_id) => ({ _id })) } });
    const r = await collectTwitch(
      twitchFile([badges('broadcaster'), badges('moderator', 'subscriber'), badges('Moderator'), badges()]),
    );
    expect(r.map((m) => [m.isOwner, m.isModerator])).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
  });

  test('emoticon_id が空文字・数値のときはテキストになり、空 text の fragment は捨てる', async () => {
    const frag = (fragments: unknown[]) => twitchComment({ message: { body: 'b', fragments } });
    const r = await collectTwitch(
      twitchFile([
        frag([{ text: 'a', emoticon: { emoticon_id: '' } }]),
        frag([{ text: 'b', emoticon: { emoticon_id: 25 } }]),
        frag([{ text: '' }]),
        frag([{ text: '', emoticon: { emoticon_id: '9' } }, { text: 'z' }]),
      ]),
    );
    expect(r).toHaveLength(3);
    expect(r[0]!.runs).toEqual([{ kind: 'text', text: 'a' }]);
    expect(r[1]!.runs).toEqual([{ kind: 'text', text: 'b' }]);
    expect(r[2]!.runs[0]).toMatchObject({ kind: 'emoji', alt: '' });
  });

  test('fragments が配列でない（null・欠落）とき body を使う。空 body なら捨てる', async () => {
    const r = await collectTwitch(
      twitchFile([
        twitchComment({ message: { body: 'only body', fragments: null } }),
        twitchComment({ message: { body: 'no fragments key' } }),
        twitchComment({ message: { body: '' } }),
        twitchComment({ message: null }),
      ]),
    );
    expect(r.map((m) => m.runs)).toEqual([
      [{ kind: 'text', text: 'only body' }],
      [{ kind: 'text', text: 'no fragments key' }],
    ]);
  });

  test('fragments の要素がオブジェクトでなければ、そのコメントごと捨てる', async () => {
    const r = await collectTwitch(
      twitchFile([twitchComment({ message: { body: 'b', fragments: [null] } }), twitchComment()]),
    );
    expect(r).toHaveLength(1);
  });

  test('comments の要素がオブジェクトでないとき読み飛ばす', async () => {
    const r = await collectTwitch(twitchFile([1, 'x', null, twitchComment()]));
    expect(r).toHaveLength(1);
  });

  test('ルートに comments が無い・壊れたファイル・途中打ち切りでも落ちない', async () => {
    expect(await collectTwitch('{"streamer":{}}')).toEqual([]);
    expect(await collectTwitch('not json at all')).toEqual([]);
    const full = twitchFile([twitchComment(), twitchComment({ content_offset_seconds: 30 })]);
    const cut = full.slice(0, full.indexOf('"video"') - 20);
    expect((await collectTwitch(cut)).length).toBeGreaterThanOrEqual(1);
  });

  test('巨大な embeddedData を comments の前後に置いても読み飛ばせる', async () => {
    const big = 'A'.repeat(300_000);
    const text = `{"embeddedData":{"firstParty":[{"data":"${big}"}]},"comments":[${JSON.stringify(twitchComment())}],"after":"${big}"}`;
    expect(await collectTwitch(text, 65536)).toHaveLength(1);
  });

  test('comments が閉じたあとの巨大な尾は読まない', async () => {
    const reads: number[] = [];
    const text = `{"comments":[${JSON.stringify(twitchComment())}],"tail":"${'z'.repeat(50_000)}"}`;
    const blob = new Blob([text]);
    const spy = {
      size: blob.size,
      slice: (s: number, e: number) => {
        reads.push(s);
        return blob.slice(s, e);
      },
    } as unknown as Blob;
    const { parseTwitchFile } = await import('../../src/chat/twitchParser');
    await parseTwitchFile(spy, () => {}, 100);
    expect(reads.length).toBeLessThan(5);
  });
});
