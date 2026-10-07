import { describe, expect, test } from 'vitest';
import { formatTime, PLAYBACK_RATES } from '../../src/ui/controls';

describe('formatTime', () => {
  test.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [65, '1:05'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [7594, '2:06:34'],
  ])('%f秒 → %s', (s, text) => {
    expect(formatTime(s)).toBe(text);
  });

  test('不正な値は --:--', () => {
    expect(formatTime(NaN)).toBe('--:--');
    expect(formatTime(Infinity)).toBe('--:--');
    expect(formatTime(-1)).toBe('--:--');
  });
});

test('再生速度はPC版と同じ7段階', () => {
  expect([...PLAYBACK_RATES]).toEqual([0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]);
});
