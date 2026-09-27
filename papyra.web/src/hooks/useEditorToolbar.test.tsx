// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { setAlwaysShowEditorToolbar, useAlwaysShowEditorToolbar } from './useEditorToolbar';

afterEach(() => {
  act(() => setAlwaysShowEditorToolbar(false));
});

describe('useAlwaysShowEditorToolbar', () => {
  it('is off until the person turns it on', () => {
    const { result } = renderHook(() => useAlwaysShowEditorToolbar());
    expect(result.current).toBe(false);
  });

  it('updates every reader when the preference changes, and remembers it', () => {
    const settings = renderHook(() => useAlwaysShowEditorToolbar());
    const editor = renderHook(() => useAlwaysShowEditorToolbar());

    act(() => setAlwaysShowEditorToolbar(true));

    expect(settings.result.current).toBe(true);
    expect(editor.result.current).toBe(true);
    expect(localStorage.getItem('papyra-editor-toolbar')).toBe('always');

    act(() => setAlwaysShowEditorToolbar(false));

    expect(editor.result.current).toBe(false);
    expect(localStorage.getItem('papyra-editor-toolbar')).toBeNull();
  });
});
