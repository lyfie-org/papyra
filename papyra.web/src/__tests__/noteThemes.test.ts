import { describe, it, expect } from 'vitest';
import { resolveTheme } from '../lib/noteThemes';

describe('resolveTheme', () => {
  it('returns defaults for undefined input', () => {
    const r = resolveTheme(undefined);
    expect(r.colorTheme).toBe('default');
    expect(r.artTheme).toBe('none');
  });

  it('returns defaults for empty string', () => {
    const r = resolveTheme('');
    expect(r.colorTheme).toBe('default');
    expect(r.artTheme).toBe('none');
  });

  it('resolves a color-only theme', () => {
    const r = resolveTheme('yellow');
    expect(r.colorTheme).toBe('yellow');
    expect(r.artTheme).toBe('none');
  });

  it('resolves a composite color:art theme', () => {
    const r = resolveTheme('pastel-green:groceries');
    expect(r.colorTheme).toBe('pastel-green');
    expect(r.artTheme).toBe('groceries');
  });

  it('falls back to default for an unknown color', () => {
    const r = resolveTheme('neon-purple:music');
    expect(r.colorTheme).toBe('default');
    expect(r.artTheme).toBe('music');
  });

  it('falls back to none for an unknown art', () => {
    const r = resolveTheme('dark-blue:fireworks');
    expect(r.colorTheme).toBe('dark-blue');
    expect(r.artTheme).toBe('none');
  });

  it('handles null gracefully', () => {
    const r = resolveTheme(null);
    expect(r.colorTheme).toBe('default');
    expect(r.artTheme).toBe('none');
  });
});
