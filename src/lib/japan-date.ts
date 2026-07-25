const JAPAN_UTC_OFFSET_MS = 9 * 60 * 60 * 1000;

export function getJapanDateKey(now = new Date()) {
  if (Number.isNaN(now.getTime())) {
    throw new Error('Invalid date');
  }

  return new Date(now.getTime() + JAPAN_UTC_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}
