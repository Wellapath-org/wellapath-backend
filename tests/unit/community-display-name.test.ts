/**
 * Display-name rules (contract §7.2, P7 + the 2026-11-08 trimming decision) as pure functions,
 * over the shared boundary cases in the pinned OpenAPI copy. Runs without a database; the HTTP
 * path (stored value, 400 envelope) is covered in tests/community/content.test.ts.
 */
import { ApiError } from '../../src/community/http';
import { canonicalDisplayName, validateDisplayName } from '../../src/community/routes/me';
import { DISPLAY_NAME_CASES } from '../helpers/display-name-cases';

const ruleOf = (raw: string): string | undefined => {
  try {
    validateDisplayName(raw);
    return undefined;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return (error.details as { rule?: string } | undefined)?.rule;
  }
};

describe('shared display-name cases (OpenAPI x-wellapath-display-name-cases)', () => {
  it('the list covers every boundary the decision names', () => {
    const rules = DISPLAY_NAME_CASES.map(c => c.rule ?? 'ok');
    for (const r of ['ok', 'min_length', 'max_length', 'not_allowed_value', 'pattern']) {
      expect(rules).toContain(r);
    }
    expect(DISPLAY_NAME_CASES.some(c => c.input.trim() === '' && c.input !== '')).toBe(true);
  });

  it.each(DISPLAY_NAME_CASES.map(c => [JSON.stringify(c.input), c] as const))('%s', (_l, c) => {
    if (c.stored !== undefined) {
      expect(validateDisplayName(c.input)).toBe(c.stored);
    } else {
      expect(ruleOf(c.input)).toBe(c.rule);
    }
  });

  it('trims exactly the ECMAScript trim set and nothing inside the name', () => {
    expect(canonicalDisplayName('  Sunny  Mum 　')).toBe('Sunny  Mum');
    expect(canonicalDisplayName('\u0085x')).toBe('\u0085x');
  });
});
