// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import CollabPresence from './CollabPresence';

afterEach(cleanup);

/** Just enough of a provider: an awareness with fixed states. */
function providerWith(states: Record<number, unknown>): HocuspocusProvider {
  const awareness = {
    clientID: 1,
    getStates: () => new Map(Object.entries(states).map(([id, state]) => [Number(id), state])),
    on: () => {},
    off: () => {},
  };
  return { awareness } as unknown as HocuspocusProvider;
}

describe('CollabPresence', () => {
  it('shows an agent on my own account as a badge, but folds away my other tabs', () => {
    const provider = providerWith({
      1: { name: 'Me', awarenessData: { uid: 7, username: 'rahul' } },
      2: { name: 'Me', awarenessData: { uid: 7, username: 'rahul' } },
      3: { name: 'Bea', awarenessData: { uid: 9, username: 'bea' } },
      4: { name: 'claude-japan', awarenessData: { uid: 7, username: 'rahul', agent: true } },
    });
    const { getByRole, getAllByRole } = render(
      <CollabPresence provider={provider} status="live" cursorsRef={{ current: null }} selfUid={7} />,
    );

    expect(getAllByRole('listitem')).toHaveLength(2);
    expect(getByRole('img', { name: 'claude-japan, an agent, is editing' })).toBeTruthy();
    expect(getByRole('button', { name: /^Bea — editing/ })).toBeTruthy();
  });
});
