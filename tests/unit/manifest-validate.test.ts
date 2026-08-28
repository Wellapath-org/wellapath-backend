/**
 * Structural validation of the candidate manifest contract.
 *
 * The governing property is fail-closed: nothing unknown, absent or malformed may pass, and
 * nothing may be silently ignored or defaulted. Fixture-driven negative cases live in
 * `manifest-fixtures.test.ts`; this file exercises the validator directly.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CandidateManifest, ReasonCode } from '../../src/manifest/contract';
import { validateManifest } from '../../src/manifest/validate';

const loadFixture = (name: string): CandidateManifest =>
  JSON.parse(
    readFileSync(join(__dirname, '../fixtures/manifest', name), 'utf8'),
  ) as CandidateManifest;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const codes = (value: unknown): ReasonCode[] => validateManifest(value).reasons.map(r => r.code);

describe('validateManifest — structural fail-closed behaviour', () => {
  it('accepts the valid baseline manifest fixture', () => {
    const result = validateManifest(loadFixture('baseline.manifest.json'));
    expect(result.reasons).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts the blocked-candidates manifest fixture (structurally valid, never eligible)', () => {
    const result = validateManifest(loadFixture('blocked-candidates.manifest.json'));
    expect(result.reasons).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a non-object manifest outright', () => {
    for (const value of [null, undefined, 'manifest', 42, []]) {
      expect(codes(value)).toContain('MANIFEST_MALFORMED');
    }
  });

  it('rejects a missing manifest_version rather than assuming one', () => {
    const manifest = clone(loadFixture('baseline.manifest.json')) as unknown as Record<
      string,
      unknown
    >;
    delete manifest.manifest_version;
    expect(codes(manifest)).toContain('MISSING_REQUIRED_FIELD');
  });

  it('reports every defect, not only the first', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    const target = manifest.artifacts[0] as unknown as Record<string, unknown>;
    target.content_type = 'text/html';
    target.schema_version = 'wellapath.artifact/9';
    const found = codes(manifest);
    expect(found).toContain('CONTENT_TYPE_UNSUPPORTED');
    expect(found).toContain('UNSUPPORTED_ARTIFACT_SCHEMA');
  });

  it('rejects a published descriptor with no publication date', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    manifest.artifacts[0].published_at = null;
    expect(codes(manifest)).toContain('MALFORMED_FIELD');
  });

  it('rejects an object key outside the immutable naming convention', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    manifest.artifacts[0].object_key = 'kb-latest.json';
    delete (manifest.artifacts[0] as unknown as Record<string, unknown>).url;
    expect(codes(manifest)).toContain('OBJECT_KEY_INVALID');
  });

  it('rejects a url that does not resolve to the declared object key', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    manifest.artifacts[0].url =
      'https://pub-8bc2ba0d7e7647799d89662d70f23c45.r2.dev/some-other-object.json';
    expect(codes(manifest)).toContain('ORIGIN_NOT_APPROVED');
  });

  it('rejects an empty target_environments list — no environment is implied', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    manifest.artifacts[0].target_environments = [];
    expect(codes(manifest)).toContain('MALFORMED_FIELD');
  });

  it('rejects an unknown environment name', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    (manifest.artifacts[0].target_environments as unknown as string[]) = ['staging', 'qa'];
    expect(codes(manifest)).toContain('MALFORMED_FIELD');
  });

  it('rejects a blocker with an unknown status rather than treating it as resolved', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    (manifest.artifacts[0].blockers as unknown as Record<string, unknown>[]) = [
      { id: 'SB-1', status: 'probably_fine' },
    ];
    expect(codes(manifest)).toContain('MALFORMED_FIELD');
  });

  it('rejects a granted approval that cites no decision', () => {
    const manifest = clone(loadFixture('baseline.manifest.json'));
    manifest.artifacts[0].approvals.product.decision_ref = null;
    expect(codes(manifest)).toContain('MALFORMED_FIELD');
  });

  it('a manifest that fails validation is unusable regardless of how minor the defect looks', () => {
    const manifest = clone(loadFixture('baseline.manifest.json')) as unknown as Record<
      string,
      unknown
    >;
    manifest.comment = 'just a note';
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.reasons.map(r => r.code)).toContain('UNKNOWN_FIELD');
  });
});
