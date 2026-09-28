import { describe, expect, it } from 'vitest';
import { editedLabel, formatOffset, timeZoneGroups, zoneCity, zoneOffsetLabel } from './timeZone';

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

describe('zone labels', () => {
  it('formats offsets the way people say them', () => {
    expect(formatOffset(330)).toBe('UTC+5:30');
    expect(formatOffset(-480)).toBe('UTC−8');
    expect(formatOffset(0)).toBe('UTC');
    expect(formatOffset(345)).toBe('UTC+5:45');
  });

  it('names cities, not paths, and today’s names', () => {
    expect(zoneCity('Asia/Calcutta')).toBe('Kolkata');
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires (Argentina)');
    expect(zoneCity('UTC')).toBe('UTC');
  });

  it('groups zones by country and never loses the saved one', () => {
    const groups = timeZoneGroups('Asia/Kolkata');
    const india = groups.find(g => g.code === 'IN');
    expect(india?.zones.some(z => z.id === 'Asia/Kolkata' || z.id === 'Asia/Calcutta')).toBe(true);
    expect(groups.flatMap(g => g.zones).some(z => z.id === 'Asia/Kolkata')).toBe(true);
    const us = groups.find(g => g.code === 'US');
    expect(us && us.zones.length).toBeGreaterThan(5);
    expect(zoneOffsetLabel('Asia/Kolkata')).toBe('UTC+5:30');
  });
});
