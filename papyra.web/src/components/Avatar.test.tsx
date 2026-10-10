// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import Avatar from './Avatar';
import { initialsOf } from '../lib/initials';
import { bumpAvatarVersion } from '../lib/avatarVersion';

afterEach(cleanup);

describe('Avatar', () => {
  it('shows the picture, and the initial on an accent disc when there is none', () => {
    const { container } = render(<Avatar name="bea" size={40} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/auth/avatar');
    expect(container.querySelector('.avatar--initial')).toBeNull();

    fireEvent.error(img);
    expect(container.textContent).toBe('B');
    expect(container.querySelector('.avatar--initial')).not.toBeNull();
  });

  it('refreshes every avatar on the page after an upload, and retries after a failure', () => {
    const { container } = render(<><Avatar name="a" /><Avatar username="bea" /></>);
    fireEvent.error(container.querySelectorAll('img')[0]);
    expect(container.querySelectorAll('img')).toHaveLength(1);

    act(() => bumpAvatarVersion());
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toHaveLength(2); // the failed one retried with the new version
    expect(srcs.every((s) => /\?v=\d+$/.test(s!))).toBe(true);
    expect(srcs[1]).toMatch(/^\/api\/auth\/avatar\/bea\?v=/);
  });

  it('shows first- and last-name initials when there is no picture', () => {
    const { container } = render(<Avatar username="ada" name="Ada Byron Lovelace" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.textContent).toBe('AL');
    expect(initialsOf('Bea', 'bea')).toBe('B');
    expect(initialsOf('  zoë   ångström ', 'z')).toBe('ZÅ');
    expect(initialsOf('Ada (work) Lovelace')).toBe('AL');
    expect(initialsOf(null, '@swastika')).toBe('S');
    expect(initialsOf('', '')).toBe('?');
  });
});
