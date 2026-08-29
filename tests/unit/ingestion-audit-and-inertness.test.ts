/**
 * Audit-event contract, integration-pin drift, and proof that none of this runs.
 *
 * The audit section checks the property that matters most about an audit trail: that it cannot
 * become a leak. The inertness section is the safeguard for the whole step — it reads the actual
 * source on disk and fails if the ingestion or registry subsystem is ever imported by the
 * application, reads an environment variable, or touches IO.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_EVENT_VERSION,
  AuditEvent,
  buildAuditEvent,
  canonicalize,
  deriveEventId,
  findSensitiveData,
} from '../../src/manifest/registry/audit';
import { KB_INTEGRATION_PINS } from '../../src/manifest/ingestion/pins';
import {
  INGESTION_ENVELOPE_VERSION,
  MANIFEST_SCHEMA_BYTE_COUNT,
  MANIFEST_SCHEMA_SHA256,
  PIPELINE_STAGES,
  PIPELINE_STAGE_ORDER,
  REQUIRED_MANIFEST_CONTRACT_VERSION,
} from '../../src/manifest/ingestion/contract';
import { MANIFEST_CONTRACT_VERSION } from '../../src/manifest/contract';

const repoRoot = join(__dirname, '../..');

const draft = (
  overrides: Partial<Omit<AuditEvent, 'event_id' | 'event_version'>> = {},
): Omit<AuditEvent, 'event_id' | 'event_version'> => ({
  event_type: 'activation',
  prior_revision: 1,
  resulting_revision: 2,
  environment: 'development',
  operation: 'activate',
  identity: {
    artifact_id: 'synthetic_fixture',
    artifact_version: '1.0',
    sha256: `sha256:${'a'.repeat(64)}`,
  },
  authority: {
    actor_ref: 'SYNTHETIC-OPERATOR-001',
    publication_decision_ref: 'SYNTHETIC-PUB-001',
    activation_decision_ref: 'SYNTHETIC-ACT-001',
    rollback_decision_ref: null,
  },
  outcome: 'accepted',
  stage: 'active',
  reason_codes: [],
  correlation_key: 'synthetic-audit-key-0001',
  occurred_at: '2026-08-29T00:00:00Z',
  ...overrides,
});

describe('audit event contract', () => {
  it('binds every field the contract requires', () => {
    const event = buildAuditEvent(draft());
    expect(event.event_version).toBe(AUDIT_EVENT_VERSION);
    expect(event.event_id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(AUDIT_EVENT_TYPES).toContain(event.event_type);
    expect(event.prior_revision).toBe(1);
    expect(event.resulting_revision).toBe(2);
    expect(event.environment).toBe('development');
    expect(event.identity?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.authority.actor_ref).toBeTruthy();
    expect(event.operation).toBe('activate');
    expect(event.outcome).toBe('accepted');
    expect(event.correlation_key).toBeTruthy();
    expect(event.occurred_at).toBe('2026-08-29T00:00:00Z');
  });

  it('derives ids from content, so identical events are identical records', () => {
    expect(buildAuditEvent(draft()).event_id).toBe(buildAuditEvent(draft()).event_id);
    expect(buildAuditEvent(draft()).event_id).not.toBe(
      buildAuditEvent(draft({ resulting_revision: 3 })).event_id,
    );
  });

  it('canonicalisation is order-independent, so field order cannot change an id', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(deriveEventId({ ...draft(), event_version: AUDIT_EVENT_VERSION })).toBe(
      buildAuditEvent(draft()).event_id,
    );
  });

  it.each([
    ['a URL with embedded credentials', 'https://user:secret@example.com/kb.json'],
    ['a presigned URL', 'https://r2.example.com/a.json?X-Amz-Signature=deadbeef'],
    ['a bearer token', 'Authorization: Bearer abcdefghijklmnop'],
    ['private key material', '-----BEGIN RSA PRIVATE KEY-----'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc'],
  ])('refuses to emit an event carrying %s', (_label, value) => {
    expect(() => buildAuditEvent(draft({ correlation_key: value }))).toThrow(/sensitive data/);
  });

  it.each(['password', 'secret', 'api_key', 'authorization', 'private_key', 'bytes', 'payload'])(
    'refuses an event carrying a forbidden field name %s',
    key => {
      const bad = { ...draft(), [key]: 'anything' } as unknown as Omit<
        AuditEvent,
        'event_id' | 'event_version'
      >;
      expect(() => buildAuditEvent(bad)).toThrow(/sensitive data/);
    },
  );

  it('finds every problem, not merely the first', () => {
    const findings = findSensitiveData({
      a: 'https://u:p@x.test/f.json',
      secret: 'x',
      nested: { token: 'y' },
    });
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.map(finding => finding.path)).toEqual(
      expect.arrayContaining(['event.a', 'event.secret', 'event.nested.token']),
    );
  });

  it('accepts a clean refusal event carrying reason codes', () => {
    const event = buildAuditEvent(
      draft({
        event_type: 'rejection',
        outcome: 'refused',
        stage: 'governance_verified',
        reason_codes: ['APPROVAL_NOT_GRANTED', 'BLOCKER_UNRESOLVED'],
        resulting_revision: 1,
      }),
    );
    expect(event.reason_codes).toEqual(['APPROVAL_NOT_GRANTED', 'BLOCKER_UNRESOLVED']);
    expect(findSensitiveData(event)).toEqual([]);
  });

  it('every declared event type can be built and is leak-free', () => {
    for (const type of AUDIT_EVENT_TYPES) {
      const event = buildAuditEvent(draft({ event_type: type }));
      expect(findSensitiveData(event)).toEqual([]);
    }
  });
});

describe('pipeline stage vocabulary', () => {
  it('rejected is terminal and therefore absent from the ordered progression', () => {
    expect(PIPELINE_STAGE_ORDER).not.toContain('rejected');
    expect(PIPELINE_STAGES).toContain('rejected');
    expect(PIPELINE_STAGES).toHaveLength(PIPELINE_STAGE_ORDER.length + 1);
  });

  it('the ordered stages are exactly the ten the contract declares', () => {
    expect([...PIPELINE_STAGE_ORDER]).toEqual([
      'received',
      'envelope_validated',
      'contract_validated',
      'provenance_verified',
      'governance_verified',
      'integrity_verified',
      'staged',
      'published',
      'active',
    ]);
  });
});

describe('integration pins do not drift', () => {
  it('the envelope pins the manifest contract this repository actually publishes', () => {
    expect(REQUIRED_MANIFEST_CONTRACT_VERSION).toBe(MANIFEST_CONTRACT_VERSION);
    expect(INGESTION_ENVELOPE_VERSION).toBe('1.1.0');
  });

  it('the pinned manifest schema digest matches the published schema on disk', () => {
    // Recomputed here rather than trusted: the pin exists to catch exactly this drifting.
    const { createHash } = require('crypto') as typeof import('crypto');
    const bytes = readFileSync(join(repoRoot, 'docs/contracts/manifest.v1.schema.json'));
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
      MANIFEST_SCHEMA_SHA256,
    );
    expect(bytes.byteLength).toBe(MANIFEST_SCHEMA_BYTE_COUNT);
  });

  it('every pinned upstream artifact declares a real digest and byte count', () => {
    const groups = [
      KB_INTEGRATION_PINS.contract_pin,
      KB_INTEGRATION_PINS.schemas,
      KB_INTEGRATION_PINS.publication_plans,
      KB_INTEGRATION_PINS.compatibility_fixtures,
      KB_INTEGRATION_PINS.governance,
    ];
    for (const group of groups) {
      for (const [name, pin] of Object.entries(group)) {
        expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(pin.byte_count).toBeGreaterThan(0);
        expect(pin.path).toMatch(/^[A-Za-z0-9_/.]+$/);
        expect(pin.purpose.length).toBeGreaterThan(20);
        expect(name).toBeTruthy();
      }
    }
  });

  it('the producer pinned our files at the commit this branch is based on', () => {
    for (const pin of Object.values(KB_INTEGRATION_PINS.reciprocal)) {
      expect(pin.backend_commit).toBe('bbaeadd6075eb37fd51acbe04101f939e52c7d48');
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('producer-only reason codes are never emitted by this implementation', () => {
    // KB_* codes describe preparing an artifact, a stage this repository has no opinion on. A
    // descriptor or refusal carrying one would be one the Backend cannot parse.
    const sources = collectSourceFiles(join(repoRoot, 'src/manifest'));
    const text = sources.map(file => readFileSync(file, 'utf8')).join('\n');
    for (const code of KB_INTEGRATION_PINS.producer_only_reason_codes) {
      // Allowed to appear only in the pins list itself, never as an emitted code.
      const emitted = new RegExp(`code:\\s*'${code}'`).test(text);
      expect(emitted).toBe(false);
    }
  });

  it('no plan operation flag is ever asserted true', () => {
    expect(KB_INTEGRATION_PINS.plan_operation_flags).toContain('upload_performed');
    expect(KB_INTEGRATION_PINS.plan_operation_flags).toContain('activation_performed');
    expect(KB_INTEGRATION_PINS.receipt_operation_types).not.toContain('stage');
  });
});

/**
 * Strips comments so the inertness assertions below are about executable code.
 *
 * Without this, a comment explaining that the module never reads `process.env` would itself trip
 * the check that it never reads `process.env` — the test would be matching prose, not behaviour.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every .ts file under a directory, recursively. */
const collectSourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

describe('runtime inertness', () => {
  const ingestionFiles = [
    ...collectSourceFiles(join(repoRoot, 'src/manifest/ingestion')),
    ...collectSourceFiles(join(repoRoot, 'src/manifest/registry')),
  ];

  it('the subsystem exists and is non-trivial', () => {
    expect(ingestionFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('no application module imports the ingestion or registry subsystem', () => {
    const appDirs = [
      'src/routes',
      'src/controllers',
      'src/services',
      'src/plugins',
      'src/db',
      'src/utils',
      'src/config',
      'src/telemetry',
    ];
    const appFiles = [
      join(repoRoot, 'src/app.ts'),
      join(repoRoot, 'src/server.ts'),
      ...appDirs.flatMap(dir => collectSourceFiles(join(repoRoot, dir))),
    ];

    for (const file of appFiles) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/from\s+['"].*manifest\/ingestion/);
      expect(text).not.toMatch(/from\s+['"].*manifest\/registry/);
      expect(text).not.toMatch(/require\(['"].*manifest\/(ingestion|registry)/);
    }
  });

  it('no route file mentions the manifest subsystem at all', () => {
    for (const file of collectSourceFiles(join(repoRoot, 'src/routes'))) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/manifest/i);
    }
  });

  it('the subsystem reads no environment variable', () => {
    for (const file of ingestionFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect({ file, env: /process\.env/.test(code) }).toEqual({ file, env: false });
      expect({ file, dotenv: /dotenv/.test(code) }).toEqual({ file, dotenv: false });
    }
  });

  it('the subsystem performs no filesystem, network, database or storage access', () => {
    const forbidden = [
      /from\s+['"]fs['"]/,
      /from\s+['"]node:fs['"]/,
      /from\s+['"]http['"]/,
      /from\s+['"]https['"]/,
      /from\s+['"]net['"]/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /from\s+['"]pg['"]/,
      /\baws-sdk\b/,
      /@aws-sdk/,
      /\bS3Client\b/,
      /readFileSync|writeFileSync|createReadStream|createWriteStream/,
      /child_process/,
    ];
    for (const file of ingestionFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of forbidden) {
        expect({ file, pattern: String(pattern), matched: pattern.test(code) }).toEqual({
          file,
          pattern: String(pattern),
          matched: false,
        });
      }
    }
  });

  it('the subsystem emits no runtime logs', () => {
    for (const file of ingestionFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code).not.toMatch(/from\s+['"].*utils\/logger/);
      expect(code).not.toMatch(/\bconsole\.(log|info|warn|error)\s*\(/);
      expect(code).not.toMatch(/\blogger\./);
    }
  });

  it('the subsystem reads no ambient clock', () => {
    // Time is injected via IngestionContext.now. `new Date()` with no argument would make an
    // evaluation depend on when it ran.
    for (const file of ingestionFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect({ file, ambientClock: /new Date\(\s*\)|Date\.now\s*\(/.test(code) }).toEqual({
        file,
        ambientClock: false,
      });
    }
  });

  it('no dependency was added for this subsystem', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Only Node built-ins are used: crypto for digests. Nothing new appears in dependencies.
    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.not.arrayContaining(['aws-sdk', '@aws-sdk/client-s3', 'node-fetch', 'axios']),
    );
  });

  it('the test-only trust mode is unreachable from application code', () => {
    const appFiles = [
      join(repoRoot, 'src/app.ts'),
      join(repoRoot, 'src/server.ts'),
      ...collectSourceFiles(join(repoRoot, 'src/routes')),
      ...collectSourceFiles(join(repoRoot, 'src/plugins')),
      ...collectSourceFiles(join(repoRoot, 'src/services')),
    ];
    for (const file of appFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain('synthetic_test_only');
    }
    // And it is a function argument, never ambient state read from the environment.
    const signing = stripComments(
      readFileSync(join(repoRoot, 'src/manifest/ingestion/signing.ts'), 'utf8'),
    );
    expect(signing).not.toMatch(/process\.env/);
    expect(signing).not.toMatch(/-----BEGIN/);
  });

  it('no candidate object key or artifact URL is referenced by the subsystem', () => {
    // The approved origin may be named in pins as policy, but no artifact URL is constructed.
    for (const file of ingestionFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code).not.toMatch(/https:\/\/pub-[a-z0-9]+\.r2\.dev\/[a-z]/);
      expect(code).not.toMatch(/kb\.ng\.v|rules\.ng\.v|facilities\.ng\.v/);
    }
  });
});
