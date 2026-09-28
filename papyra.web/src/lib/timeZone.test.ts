import { describe, expect, it } from 'vitest';
import { editedLabel } from './timeZone';

describe('editedLabel', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');

  it('says "just now" inside the first minute', () => {
    expect(editedLabel('2026-09-28T11:59:30Z', 'UTC', now)).toBe('Edited just now');
  });

  it('reads the day in the chosen zone, not the browser’s', () => {
    // 23:30 UTC on the 27th is already the 28th in Kolkata (UTC+5:30)…
    expect(editedLabel('2026-09-27T23:30:00Z', 'Asia/Kolkata', now)).toMatch(/^Edited \d/);
    // …but still "yesterday" in UTC.
    expect(editedLabel('2026-09-27T23:30:00Z', 'UTC', now)).toMatch(/^Edited yesterday, /);
  });

  it('adds the year only for another year', () => {
    expect(editedLabel('2025-03-01T10:00:00Z', 'UTC', now)).toMatch(/2025/);
    expect(editedLabel('2026-03-01T10:00:00Z', 'UTC', now)).not.toMatch(/2026/);
  });
});
