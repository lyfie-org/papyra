// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { installChecklistRoles, nameChecklists } from './checklistRoles';

const list = (items: string) => { const ul = document.createElement('ul'); ul.className = 'luthor-list-ul'; ul.innerHTML = items; return ul; };

describe('checklist roles', () => {
  it('names a list of checkboxes a group, and leaves a plain list alone', () => {
    const checks = list('<li role="checkbox" aria-checked="false">a</li>');
    const bullets = list('<li>a</li>');
    document.body.append(checks, bullets);
    nameChecklists(document);
    expect(checks.getAttribute('role')).toBe('group');
    expect(bullets.getAttribute('role')).toBeNull();
    checks.remove(); bullets.remove();
  });

  it('keeps a role something else already gave, and names lists drawn later', async () => {
    const stop = installChecklistRoles();
    const given = list('<li role="checkbox">a</li>');
    given.setAttribute('role', 'list');
    const later = list('<li role="checkbox">b</li>');
    document.body.append(given, later);
    await Promise.resolve();
    await Promise.resolve();
    expect(given.getAttribute('role')).toBe('list');
    expect(later.getAttribute('role')).toBe('group');
    stop();
  });
});
