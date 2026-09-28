// Keeping password managers to the sign-in form.
//
// Bitwarden, 1Password, LastPass and the browser all decide for themselves
// which fields look like logins, and they guess generously: a password-type
// box of any kind, or a text box whose label says "username". That hung an
// account popup off the vault PIN, the share dialog's people search, API-token
// fields and the like — places where filling a saved login is never right.
// Sign-in, first-password and change-password forms keep their normal
// autocomplete hints; everything else spreads these.

/**
 * Opt-outs each manager honours. `autocomplete="off"` alone is ignored by most
 * of them for anything that looks like a login, hence the vendor attributes.
 */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;

// Where the browser can draw dots over a plain text box, a secret that is not a
// login password (a PIN, an API token, an SMTP password) is a text input with
// dots instead of type="password" — the type is what makes every manager treat
// it as a login. Elsewhere it stays a password input: showing a PIN in the
// clear is worse than an unwanted popup.
const CAN_MASK = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
  && CSS.supports('-webkit-text-security', 'disc');

/** Props for a masked secret that is not an account login. Pair with NO_AUTOFILL's intent. */
export const MASKED_SECRET = {
  ...NO_AUTOFILL,
  type: CAN_MASK ? 'text' : 'password',
  'data-masked': '',
  spellCheck: false,
  autoCorrect: 'off',
  autoCapitalize: 'none',
} as const;
