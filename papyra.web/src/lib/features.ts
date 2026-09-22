/**
 * Feature switches for work that is built but not shipped yet.
 *
 * A switch here hides a whole feature from the UI without deleting the code that
 * implements it: the hooks, panels and settings tabs stay where they are, ready
 * to come back by flipping one constant.
 *
 * `AI_ENABLED` covers everything the assistant touches — "Ask your notes", the
 * conversation panel, the AI settings tab and its entries in search. The server
 * has the matching switch (`Features:Ai`, or `PAPYRA_AI_ENABLED`), which is what
 * actually takes the endpoints away; this one keeps the UI from offering a
 * feature the server will refuse.
 *
 * Typed as `boolean` on purpose: a literal `false` would let the compiler treat
 * every guarded branch as dead code and flag it.
 */
export const AI_ENABLED: boolean = false;
