// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clientErrorInfo, errorReportText, serverErrorInfo } from './errorReport';

describe('serverErrorInfo', () => {
  it('reads the server error shape: reference, request and trace', () => {
    const info = serverErrorInfo({
      error: 'Papyra hit an unexpected error.',
      code: 'server_error',
      errorId: 'E7K2-QX9M',
      detail: { stack: 'System.Exception: boom', method: 'PUT', path: '/api/notes/a', version: '0.2.3' },
    }, 500);
    expect(info?.errorId).toBe('E7K2-QX9M');
    expect(info?.request).toBe('PUT /api/notes/a');
    expect(info?.stack).toBe('System.Exception: boom');
  });

  it('ignores any other error body', () => {
    expect(serverErrorInfo({ error: 'Invalid credentials.' }, 500)).toBeNull();
    expect(serverErrorInfo(null, 500)).toBeNull();
  });
});

describe('clientErrorInfo', () => {
  it('keeps the frames, shortens bundle URLs to file names', () => {
    const err = new TypeError('x is undefined');
    err.stack = 'TypeError: x is undefined\n    at Card (https://papyra.example.com/assets/index-abc123.js:10:5)';
    const info = clientErrorInfo(err, '\n    at Card\n    at Grid');
    expect(info.stack).toBe('TypeError: x is undefined\nat Card (index-abc123.js:10:5)');
    expect(info.componentStack).toBe('at Card\nat Grid');
  });
});

describe('errorReportText', () => {
  it('leads with the reference someone can quote', () => {
    const text = errorReportText({ title: 'Boom', message: 'm', errorId: 'ABCD-EFGH', status: 500, request: 'GET /api/x', stack: 'trace' });
    expect(text.split('\n')[0]).toBe('Papyra error ABCD-EFGH: Boom');
    expect(text).toContain('Request:  GET /api/x → 500');
    expect(text.endsWith('trace')).toBe(true);
  });
});
