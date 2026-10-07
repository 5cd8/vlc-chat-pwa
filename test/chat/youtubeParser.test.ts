import { describe, expect, test } from 'vitest';
import { parseTimestamp } from '../../src/chat/youtubeParser';
import { collectYoutube, youtubeLine, ytRenderer } from './helpers';

describe('parseTimestamp', () => {
  test('MM:SS と H:MM:SS を秒にする', () => {
    expect(parseTimestamp('1:02')).toBe(62);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('0:00')).toBe(0);
  });

  test.each(['-0:05', ':30', '1:2:3:4', '', 'a:b', '12', '1:', '1: 2', '+1:02'])('不正な入力 %j は捨てる', (t) => {
    expect(parseTimestamp(t)).toBeNull();
  });
});

describe('YouTube JSON Lines', () => {
  test('基本：時刻・投稿者・本文', async () => {
    const [m] = await collectYoutube(youtubeLine(ytRenderer()));
    expect(m).toEqual({
      timeSeconds: 62,
      author: 'Bob',
      isOwner: false,
      isModerator: false,
      runs: [{ kind: 'text', text: 'hi' }],
    });
  });

  test('バッジ：iconType と tooltip（大文字小文字を区別しない）', async () => {
    const badge = (iconType?: string, tooltip?: string) => ({
      liveChatAuthorBadgeRenderer: { ...(iconType ? { icon: { iconType } } : {}), ...(tooltip ? { tooltip } : {}) },
    });
    const r = await collectYoutube(
      [
        youtubeLine(ytRenderer({ authorBadges: [badge('OWNER')] })),
        youtubeLine(ytRenderer({ authorBadges: [badge('moderator')] })),
        youtubeLine(ytRenderer({ authorBadges: [badge(undefined, 'Channel OWNER')] })),
        youtubeLine(ytRenderer({ authorBadges: [badge(undefined, 'moderator!')] })),
        youtubeLine(ytRenderer({ authorBadges: [badge(undefined, 'Member (2 months)')] })),
      ].join('\n'),
    );
    expect(r.map((m) => [m.isOwner, m.isModerator])).toEqual([
      [true, false],
      [false, true],
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  test('絵文字：カスタムは画像run（URLは加工しない）、標準は emojiId のテキスト、テキストと分割される', async () => {
    const runs = [
      { text: 'a' },
      { text: 'b' },
      { emoji: { isCustomEmoji: true, shortcuts: [':yay:'], image: { thumbnails: [{ url: 'https://x/y.png?a=1&b=2' }] } } },
      { text: 'c' },
      { emoji: { emojiId: '😀', image: { thumbnails: [{ url: 'https://x/u.png' }] }, isCustomEmoji: false } },
      { emoji: { emojiId: '' } },
    ];
    const [m] = await collectYoutube(youtubeLine(ytRenderer({ message: { runs } })));
    expect(m!.runs).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'emoji', url: 'https://x/y.png?a=1&b=2', alt: ':yay:' },
      { kind: 'text', text: 'c' },
      { kind: 'text', text: '😀' },
    ]);
  });

  test('isCustomEmoji が欠落・非真偽値のときは画像URLの有無で決める。真でも画像が無ければ emojiId', async () => {
    const em = (emoji: Record<string, unknown>) => youtubeLine(ytRenderer({ message: { runs: [{ emoji }] } }));
    const r = await collectYoutube(
      [
        em({ image: { thumbnails: [{ url: 'u1' }] }, emojiId: 'id1' }),
        em({ isCustomEmoji: 'yes', image: { thumbnails: [{ url: 'u2' }] }, emojiId: 'id2' }),
        em({ isCustomEmoji: true, emojiId: 'id3' }),
        em({ isCustomEmoji: true, image: { thumbnails: [{ url: 'u4' }] }, emojiId: 'id4' }),
      ].join('\n'),
    );
    expect(r.map((m) => m.runs)).toEqual([
      [{ kind: 'emoji', url: 'u1', alt: 'id1' }],
      [{ kind: 'emoji', url: 'u2', alt: 'id2' }],
      [{ kind: 'text', text: 'id3' }],
      [{ kind: 'emoji', url: 'u4', alt: 'id4' }],
    ]);
  });

  test('alt は shortcuts[0]、無ければ accessibility の label', async () => {
    const emoji = {
      isCustomEmoji: true,
      image: { thumbnails: [{ url: 'u' }], accessibility: { accessibilityData: { label: 'ラベル' } } },
    };
    const [m] = await collectYoutube(youtubeLine(ytRenderer({ message: { runs: [{ emoji }] } })));
    expect(m!.runs).toEqual([{ kind: 'emoji', url: 'u', alt: 'ラベル' }]);
  });

  test('スーパーチャット・メンバー加入は本文があれば残し、無ければ捨てる。通常メッセージは本文無しでも残る', async () => {
    const r = await collectYoutube(
      [
        youtubeLine(ytRenderer(), 'liveChatPaidMessageRenderer'),
        youtubeLine(ytRenderer({ message: undefined }), 'liveChatPaidMessageRenderer'),
        youtubeLine(ytRenderer(), 'liveChatMembershipItemRenderer'),
        youtubeLine(ytRenderer({ message: { runs: [] } }), 'liveChatMembershipItemRenderer'),
        youtubeLine(ytRenderer({ message: undefined })),
        youtubeLine(ytRenderer(), 'liveChatTickerItemRenderer'),
      ].join('\n'),
    );
    expect(r.map((m) => m.runs.length)).toEqual([1, 1, 0]);
  });

  test('"-" を含む時刻・時刻なし・不正な時刻の行は捨てる', async () => {
    const r = await collectYoutube(
      [
        youtubeLine(ytRenderer({ timestampText: { simpleText: '-0:05' } })),
        youtubeLine(ytRenderer({ timestampText: undefined })),
        youtubeLine(ytRenderer({ timestampText: { simpleText: ':30' } })),
        youtubeLine(ytRenderer({ timestampText: { simpleText: '1:00:00' } })),
      ].join('\n'),
    );
    expect(r.map((m) => m.timeSeconds)).toEqual([3600]);
  });

  test('壊れた行・空行・対象外の行の後も解析を続ける', async () => {
    const r = await collectYoutube(['{broken', '', '   ', '{"a":1}', youtubeLine(ytRenderer())].join('\n'));
    expect(r).toHaveLength(1);
  });

  test('CRLF・最終行に改行なし・BOM・1バイトずつの分割で結果が変わらない', async () => {
    const text = '﻿' + [youtubeLine(ytRenderer({ authorName: { simpleText: '日本語😀' } })), youtubeLine(ytRenderer())].join('\r\n');
    const whole = await collectYoutube(text);
    expect(whole).toHaveLength(2);
    expect(whole[0]!.author).toBe('日本語😀');
    expect(await collectYoutube(text, 1)).toEqual(whole);
    expect(await collectYoutube(text, 5)).toEqual(whole);
  });

  test('\\r と \\n がチャンクの境界で分かれても行が正しく分かれる', async () => {
    const text = [youtubeLine(ytRenderer()), youtubeLine(ytRenderer())].join('\r\n') + '\r\n';
    for (let step = 1; step < 20; step++) expect(await collectYoutube(text, step)).toHaveLength(2);
  });
});
