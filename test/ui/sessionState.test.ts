import { describe, expect, test } from 'vitest';
import { classifyFiles } from '../../src/media/classify';
import type { ChatStore } from '../../src/chat/types';
import { OpenError, type EmojiDb } from '../../src/emoji/sqliteReader';
import { isNearBottom } from '../../src/ui/isNearBottom';
import { SessionController, type ParseHandlers, type SessionDeps } from '../../src/ui/sessionState';

const file = (name: string): File => ({ name }) as File;

describe('classifyFiles', () => {
  test('拡張子（大文字小文字を区別しない）で動画・チャット・絵文字に振り分ける', () => {
    const c = classifyFiles([file('A.MKV'), file('chat.JSON'), file('emoji.Sqlite')]);
    expect(c.video?.name).toBe('A.MKV');
    expect(c.videoKind).toBe('mkv');
    expect(c.chat?.name).toBe('chat.JSON');
    expect(c.emoji?.name).toBe('emoji.Sqlite');
    expect(c.missing).toEqual([]);
  });

  test.each([
    ['a.mp4', 'native'],
    ['a.MOV', 'native'],
    ['a.webm', 'native'],
    ['a.mkv', 'mkv'],
  ])('%s の再生方式は %s', (name, kind) => {
    expect(classifyFiles([file(name)]).videoKind).toBe(kind);
  });

  test('複数あれば最初の1つを採用し、余りと対象外を通知用に残す', () => {
    const c = classifyFiles([file('1.mp4'), file('2.mkv'), file('a.json'), file('b.json'), file('c.txt'), file('noext')]);
    expect(c.video?.name).toBe('1.mp4');
    expect(c.chat?.name).toBe('a.json');
    expect(c.extras).toEqual(['2.mkv', 'b.json']);
    expect(c.unknown).toEqual(['c.txt', 'noext']);
  });

  test('動画かチャットが無ければ不足を返す（sqlite は省略可）', () => {
    expect(classifyFiles([file('a.json')]).missing).toEqual(['動画']);
    expect(classifyFiles([file('a.mp4')]).missing).toEqual(['チャット']);
    expect(classifyFiles([]).missing).toEqual(['動画', 'チャット']);
    expect(classifyFiles([file('a.mp4'), file('a.json')]).missing).toEqual([]);
  });
});

describe('isNearBottom', () => {
  test.each([
    [0, 100, 100, true], // 内容が短い
    [900, 100, 1000, true], // 最下部
    [880, 100, 1000, true], // しきい値内（20px）
    [870, 100, 1000, false], // しきい値の外（30px）
    [0, 100, 1000, false], // 上へスクロール中
  ])('scrollTop=%i clientHeight=%i scrollHeight=%i → %s', (top, h, total, expected) => {
    expect(isNearBottom(top, h, total)).toBe(expected);
  });
});

function harness() {
  const log: string[] = [];
  const handlers: ParseHandlers[] = [];
  const emojiResolvers: ((r: EmojiDb | OpenError) => void)[] = [];
  const states: string[] = [];
  const deps: SessionDeps = {
    startChatParse: (f, h) => {
      const id = handlers.length;
      handlers.push(h);
      log.push(`parse:start:${f.name}`);
      return { dispose: () => log.push(`parse:terminate:${id}`) };
    },
    createPlayer: (f, kind) => {
      log.push(`player:create:${f.name}:${kind}`);
      return { dispose: () => log.push(`player:dispose:${f.name}`) };
    },
    openEmoji: (f) => {
      log.push(`emoji:open:${f.name}`);
      return new Promise((r) => emojiResolvers.push(r));
    },
    resetViews: () => log.push('reset'),
    onChatReady: (s) => log.push(`chat:ready:${s.times.length}`),
    setEmojiSource: (db) => log.push(`emoji:source:${db ? 'db' : 'null'}`),
    onChange: (s) => states.push(`${s.chat.status}/${s.emoji.status}`),
  };
  return { controller: new SessionController(deps), log, handlers, emojiResolvers, states };
}

function fakeStore(count: number): ChatStore {
  return { times: new Uint32Array(count), offsets: new Uint32Array(count), records: [], chunkBytes: 1, emojis: [] };
}

function fakeDb(log: string[], name: string): EmojiDb {
  return {
    get: async () => null,
    close: () => log.push(`emoji:close:${name}`),
    warnings: [],
    stats: { sliceReads: 0, cachedBytes: 0 },
  };
}

describe('SessionController', () => {
  test('動画とチャットがそろえば、プレーヤーと解析を始める。sqlite 無しなら絵文字は開かない', () => {
    const h = harness();
    h.controller.select([file('v.mp4'), file('c.json')]);
    expect(h.log).toEqual(['emoji:source:null', 'reset', 'player:create:v.mp4:native', 'parse:start:c.json']);
    expect(h.controller.getState().active).toBe(true);
  });

  test('動画かチャットが無ければ再生を始めず、不足を表示する', () => {
    const h = harness();
    h.controller.select([file('v.mp4')]);
    expect(h.log).toEqual(['emoji:source:null', 'reset']);
    expect(h.controller.getState().active).toBe(false);
    expect(h.controller.getState().selection.missing).toEqual(['チャット']);
  });

  test('選び直すと、解析中のWorkerを terminate してから、旧プレーヤー・絵文字を破棄し、新しいものを作る', async () => {
    const h = harness();
    h.controller.select([file('v1.mp4'), file('c1.json'), file('e1.sqlite')]);
    h.emojiResolvers[0]!(fakeDb(h.log, 'e1'));
    await Promise.resolve();
    h.log.length = 0;
    h.controller.select([file('v2.mkv'), file('c2.json')]);
    expect(h.log).toEqual([
      'parse:terminate:0',
      'player:dispose:v1.mp4',
      'emoji:source:null',
      'emoji:close:e1',
      'reset',
      'player:create:v2.mkv:mkv',
      'parse:start:c2.json',
    ]);
  });

  test('解析が終わったらWorkerを終了し、ストアを渡す。0件は「読み取れませんでした」', () => {
    const h = harness();
    h.controller.select([file('v.mp4'), file('c.json')]);
    h.handlers[0]!.onProgress(2000);
    expect(h.controller.getState().chat).toEqual({ status: 'parsing', count: 2000 });
    h.handlers[0]!.onDone(fakeStore(3));
    expect(h.log).toContain('parse:terminate:0');
    expect(h.log).toContain('chat:ready:3');
    expect(h.controller.getState().chat).toEqual({ status: 'ready', count: 3 });

    h.controller.select([file('v.mp4'), file('c.json')]);
    h.handlers[1]!.onDone(fakeStore(0));
    expect(h.controller.getState().chat.status).toBe('empty');
    expect(h.controller.getState().chat.message).toBe('チャットを読み取れませんでした');
  });

  test('古い解析の完了・進捗は、選び直した後では無視する', () => {
    const h = harness();
    h.controller.select([file('v.mp4'), file('c1.json')]);
    h.controller.select([file('v.mp4'), file('c2.json')]);
    h.log.length = 0;
    h.handlers[0]!.onProgress(5);
    h.handlers[0]!.onDone(fakeStore(10));
    h.handlers[0]!.onError('x');
    expect(h.log).toEqual([]);
    expect(h.controller.getState().chat).toEqual({ status: 'parsing', count: 0 });
  });

  test('絵文字を開いている間に選び直したら、開けたDBをすぐ閉じる', async () => {
    const h = harness();
    h.controller.select([file('v.mp4'), file('c.json'), file('e.sqlite')]);
    h.controller.select([file('v.mp4'), file('c.json')]);
    h.log.length = 0;
    h.emojiResolvers[0]!(fakeDb(h.log, 'old'));
    await Promise.resolve();
    expect(h.log).toEqual(['emoji:close:old']);
  });

  test('sqlite が開けなくても継続し、理由を保持する', async () => {
    const h = harness();
    h.controller.select([file('v.mp4'), file('c.json'), file('e.sqlite')]);
    h.emojiResolvers[0]!(new OpenError('壊れています'));
    await Promise.resolve();
    expect(h.controller.getState().emoji).toEqual({ status: 'failed', message: '壊れています', warnings: [] });
    expect(h.controller.getState().active).toBe(true);
  });

  test('dispose はすべて破棄する', () => {
    const h = harness();
    h.controller.select([file('v.mp4'), file('c.json')]);
    h.log.length = 0;
    h.controller.dispose();
    expect(h.log).toEqual(['parse:terminate:0', 'player:dispose:v.mp4', 'emoji:source:null', 'reset']);
  });
});
