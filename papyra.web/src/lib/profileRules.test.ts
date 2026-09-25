import { describe, expect, it } from 'vitest';
import { usernameRule } from './profileRules';

// Same cases as ProfileEndpointsTests on the server — the two must agree, or the
// form would accept a name the API refuses (or the reverse).
describe('usernameRule', () => {
  it.each(['bea', 'Bea_2.0-x', 'b1', 'a'.repeat(64)])('accepts %s', (name) => {
    expect(usernameRule(name)).toBeNull();
  });

  it.each(['a', '', 'bea.', '.bea', 'be a', 'bea@home', 'björn', 'a'.repeat(65), 'bea-'])('refuses %j', (name) => {
    expect(usernameRule(name)).not.toBeNull();
  });
});
