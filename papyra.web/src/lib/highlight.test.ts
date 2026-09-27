import { describe, expect, it } from 'vitest';
import { highlightParts, queryTerms } from './highlight';

const marked = (text: string, query: string) =>
  highlightParts(text, query).filter(p => p.match).map(p => p.text);

describe('highlightParts', () => {
  it('marks every occurrence of the query, ignoring case', () => {
    expect(marked('Change Bank account at the bank', 'bank')).toEqual(['Bank', 'bank']);
  });

  it('keeps the text intact around the marks', () => {
    expect(highlightParts('Bank Passbook', 'bank').map(p => p.text).join('')).toBe('Bank Passbook');
  });

  it("honours the server highlighter's <mark> spans and drops other tags", () => {
    expect(marked('create <mark>funds</mark> <b>Bank</b> model', 'bank')).toEqual(['funds', 'Bank']);
    expect(highlightParts('<b>x</b>', 'y')).toEqual([{ text: 'x', match: false }]);
  });

  it('merges overlapping matches from several terms', () => {
    expect(marked('banking', 'bank banking')).toEqual(['banking']);
  });

  it('treats regex characters in the query literally', () => {
    expect(marked('costs (approx.) $5', '(approx.)')).toEqual(['approx.']);
    expect(marked('a+b', 'a+b')).toEqual(['a+b']);
  });

  it('returns the plain text when nothing matches', () => {
    expect(highlightParts('Groceries', 'bank')).toEqual([{ text: 'Groceries', match: false }]);
  });
});

describe('queryTerms', () => {
  it('splits on whitespace, strips quotes and dedupes longest-first', () => {
    expect(queryTerms('"Bank"  bank banking')).toEqual(['banking', 'bank']);
  });
});
