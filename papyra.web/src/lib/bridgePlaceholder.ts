// luthor ≤2.9.7 serialized a just-adopted document without the Papyra preset's
// bridge extras, so until the next commit getMarkdown() returned
// `[Unsupported blockAnchor preserved in markdown metadata]` where every `^id`
// (and wikilink, and embed) should be. That text is never the note: Papyra
// detects it so it can never be baselined on, or written to disk.
const BRIDGE_PLACEHOLDER = /\[Unsupported [\w-]+ preserved in markdown metadata\]/;

/** True when luthor handed back placeholder text instead of the note. */
export function hasBridgePlaceholder(markdown: string): boolean {
  return BRIDGE_PLACEHOLDER.test(markdown);
}
