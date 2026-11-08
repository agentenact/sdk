import { describe, expect, it } from 'bun:test';
import { RECORD_VERSION } from '../src/index.js';
import pkg from '../package.json';

describe('package', () => {
  it('exports record version 0.1 and package version 0.4.x', () => {
    expect(RECORD_VERSION).toBe('0.1');
    expect(pkg.version.startsWith('0.4.')).toBe(true);
  });
  it('every export entry carries a default condition', () => {
    for (const [key, entry] of Object.entries(pkg.exports)) {
      if (key === './package.json') continue;
      expect(entry).toHaveProperty('default');
    }
  });
});
