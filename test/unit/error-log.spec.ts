import { describeForLog } from '../../src/http/error.filter';

describe('describeForLog', () => {
  it('keeps the type, code and stack frames but drops the message', () => {
    const error = Object.assign(new Error('Unique constraint failed for email asha@example.com'), { code: 'P2002' });
    const line = describeForLog(error);
    expect(line).toMatch(/^Error \[P2002\]\n\s+at /);
    expect(line).not.toContain('asha@example.com');
  });

  it('handles non-errors', () => {
    expect(describeForLog('secret-token')).toBe('Non-error value thrown');
  });
});
