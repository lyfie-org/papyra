import { describe, expect, it } from 'vitest';
import { hasBridgePlaceholder } from './bridgePlaceholder';

describe('hasBridgePlaceholder', () => {
  it('spots luthor placeholders for any unsupported node type', () => {
    expect(hasBridgePlaceholder('Things:[Unsupported blockAnchor preserved in markdown metadata]')).toBe(true);
    expect(hasBridgePlaceholder('x [Unsupported wiki-link preserved in markdown metadata] y')).toBe(true);
  });
  it('leaves real notes alone, including ones that talk about the placeholder', () => {
    expect(hasBridgePlaceholder('Things to buy: ^xkncpelm\n\n1. Ramen ^13fphj82')).toBe(false);
    expect(hasBridgePlaceholder('[Unsupported] preserved in markdown')).toBe(false);
  });
});
