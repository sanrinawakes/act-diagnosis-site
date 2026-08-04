import { describe, expect, it } from 'vitest';
import { getJapanDateKey, getJapanMonthStartKey } from '../src/lib/japan-date';

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

describe('getJapanMonthStartKey', () => {
  it('日本時間で月末の間は当月1日を返す', () => {
    expect(
      getJapanMonthStartKey(new Date('2026-07-31T14:59:59.999Z'))
    ).toBe('2026-07-01');
  });

  it('日本時間の毎月1日午前0時に翌月へ切り替える', () => {
    expect(
      getJapanMonthStartKey(new Date('2026-07-31T15:00:00.000Z'))
    ).toBe('2026-08-01');
  });

  it('不正な日時を黙って月へ変換しない', () => {
    expect(() => getJapanMonthStartKey(new Date('invalid'))).toThrow(
      'Invalid date'
    );
  });
});
