// Mirrors `ProfileRules.UsernameProblem` on the server (Storage/ProfileRules.cs),
// so the form can say what is wrong while typing. The server stays the authority.
//
// A username has to be @mentionable: the mention pattern is
// `[A-Za-z0-9][A-Za-z0-9._-]*`, and it stops at a word boundary, so a name
// ending in `.`/`-`/`_` would mention someone else ("@bea." → "bea").

const SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function usernameRule(username: string): string | null {
  if (username.length < 2 || username.length > 64) return 'Usernames are 2–64 characters.';
  if (!SHAPE.test(username)) {
    return 'Use letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.';
  }
  return null;
}
