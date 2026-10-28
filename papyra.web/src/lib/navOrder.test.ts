// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { moved, normalizeOrder, setNavOrder } from './navOrder';

describe('normalizeOrder', () => {
  it('keeps a whole order as it is', () => {
    expect(normalizeOrder(['journal', 'notes', 'todo'])).toEqual(['journal', 'notes', 'todo']);
  });
  it('adds what is missing in the default order and drops unknowns and repeats', () => {
    expect(normalizeOrder(['journal', 'nope', 'journal'])).toEqual(['journal', 'notes', 'todo']);
    expect(normalizeOrder(null)).toEqual(['notes', 'todo', 'journal']);
  });
});

describe('moved', () => {
  it('swaps with its neighbour and stays put at the ends', () => {
    expect(moved(['notes', 'todo', 'journal'], 'journal', -1)).toEqual(['notes', 'journal', 'todo']);
    expect(moved(['notes', 'todo', 'journal'], 'notes', -1)).toEqual(['notes', 'todo', 'journal']);
    expect(moved(['notes', 'todo', 'journal'], 'journal', 1)).toEqual(['notes', 'todo', 'journal']);
  });
});

describe('setNavOrder', () => {
  it('stores a custom order and forgets the default one', () => {
    setNavOrder(['journal', 'notes', 'todo']);
    expect(localStorage.getItem('papyra-nav-order')).toBe('["journal","notes","todo"]');
    setNavOrder(['notes', 'todo', 'journal']);
    expect(localStorage.getItem('papyra-nav-order')).toBeNull();
  });
});
