import { describe, expect, it } from 'vitest';
import { getJapanDateKey } from '../src/lib/japan-date';

describe('getJapanDateKey', () => {
  it('日本時間の午前0時までは前日として扱う', () => {
    expect(getJapanDateKey(new Date('2026-07-25T14:59:59.999Z'))).toBe(
      '2026-07-25'
    );
  });

  it('日本時間の午前0時に日付を切り替える', () => {
    expect(getJapanDateKey(new Date('2026-07-25T15:00:00.000Z'))).toBe(
      '2026-07-26'
    );
  });

  it('不正な日時を黙って日付へ変換しない', () => {
    expect(() => getJapanDateKey(new Date('invalid'))).toThrow('Invalid date');
  });
});
