/**
 * Drift check between the TypeScript ingestion/audit contracts and their published JSON Schemas.
 *
 * Follows the precedent set by the telemetry and manifest contracts: a document handed to another
 * team must be provably in sync with the code that enforces it, or it is worse than no document.
 * The synthetic audit examples are validated against the published audit schema for the same
 * reason — an example that no longer matches its own schema teaches the wrong shape.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_EVENT_VERSION,
  AuditEvent,
  findSensitiveData,
} from '../../src/manifest/registry/audit';
import {
  INGESTION_ENVELOPE_VERSION,
  INGESTION_OPERATIONS,
  MANIFEST_SCHEMA_BYTE_COUNT,
  MANIFEST_SCHEMA_SHA256,
  OPTIONAL_ENVELOPE_KEYS,
  PIPELINE_STAGES,
  REQUIRED_ENVELOPE_KEYS,
  REQUIRED_MANIFEST_CONTRACT_VERSION,
  REQUIRED_PROVENANCE_KEYS,
  TRUST_MODES,
} from '../../src/manifest/ingestion/contract';
import { ENVIRONMENTS } from '../../src/manifest/contract';

const contractsDir = join(__dirname, '../../docs/contracts');
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(contractsDir, name), 'utf8')) as Record<string, unknown>;

const envelopeSchema = load('ingestion-envelope.v1.schema.json') as unknown as {
  contract_version: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, { const?: unknown; enum?: string[]; pattern?: string }>;
  definitions: {
    provenance: { required: string[]; additionalProperties: boolean };
    attestation: { properties: { trust_mode: { enum: string[] } } };
  };
};

const auditSchema = load('audit-event.v1.schema.json') as unknown as {
  contract_version: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, { const?: unknown; enum?: string[] }>;
};

describe('ingestion envelope schema stays in sync with the TypeScript contract', () => {
  it('carries the same contract version', () => {
    expect(envelopeSchema.contract_version).toBe(INGESTION_ENVELOPE_VERSION);
  });

  it('requires exactly the same envelope fields, and permits nothing more', () => {
    expect([...envelopeSchema.required].sort()).toEqual([...REQUIRED_ENVELOPE_KEYS].sort());
    expect(Object.keys(envelopeSchema.properties).sort()).toEqual(
      [...REQUIRED_ENVELOPE_KEYS, ...OPTIONAL_ENVELOPE_KEYS].sort(),
    );
    expect(envelopeSchema.additionalProperties).toBe(false);
  });

  it('pins the same manifest contract and schema digest', () => {
    expect(envelopeSchema.properties.manifest_contract_version.const).toBe(
      REQUIRED_MANIFEST_CONTRACT_VERSION,
    );
    expect(envelopeSchema.properties.manifest_schema_sha256.const).toBe(MANIFEST_SCHEMA_SHA256);
    expect(envelopeSchema.properties.manifest_schema_byte_count.const).toBe(
      MANIFEST_SCHEMA_BYTE_COUNT,
    );
  });

  it('agrees on every enum', () => {
    expect(envelopeSchema.properties.requested_operation.enum).toEqual([...INGESTION_OPERATIONS]);
    expect(envelopeSchema.properties.environment.enum).toEqual([...ENVIRONMENTS]);
    expect(envelopeSchema.definitions.attestation.properties.trust_mode.enum).toEqual([
      ...TRUST_MODES,
    ]);
  });

  it('requires the same provenance fields, closed', () => {
    expect([...envelopeSchema.definitions.provenance.required].sort()).toEqual(
      [...REQUIRED_PROVENANCE_KEYS].sort(),
    );
    expect(envelopeSchema.definitions.provenance.additionalProperties).toBe(false);
  });

  it('carries no URL, credential or byte-carrying field anywhere', () => {
    const keys = Object.keys(envelopeSchema.properties);
    expect(keys).not.toContain('url');
    expect(keys).not.toContain('bytes');
    expect(keys).not.toContain('content');
    expect(keys).not.toContain('credentials');
    expect(JSON.stringify(envelopeSchema)).not.toMatch(/presigned|Bearer |x-amz-/i);
  });
});

describe('audit event schema stays in sync with the TypeScript contract', () => {
  it('carries the same contract version', () => {
    expect(auditSchema.contract_version).toBe(AUDIT_EVENT_VERSION);
    expect(auditSchema.properties.event_version.const).toBe(AUDIT_EVENT_VERSION);
  });

  it('declares exactly the same event types', () => {
    expect(auditSchema.properties.event_type.enum).toEqual([...AUDIT_EVENT_TYPES]);
  });

  it('declares exactly the same pipeline stages', () => {
    const stages = (
      auditSchema.properties.stage as unknown as { oneOf: [{ enum: string[] }, unknown] }
    ).oneOf[0].enum;
    expect([...stages].sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it('is closed and requires every field the record carries', () => {
    expect(auditSchema.additionalProperties).toBe(false);
    expect([...auditSchema.required].sort()).toEqual(
      [
        'authority',
        'correlation_key',
        'environment',
        'event_id',
        'event_type',
        'event_version',
        'identity',
        'occurred_at',
        'operation',
        'outcome',
        'prior_revision',
        'reason_codes',
        'resulting_revision',
        'stage',
      ].sort(),
    );
  });
});

describe('synthetic audit examples', () => {
  const doc = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/ingestion/audit-events.examples.json'), 'utf8'),
  ) as { event_version: string; examples: AuditEvent[] };

  it('covers every declared event type exactly once', () => {
    expect(doc.examples.map(event => event.event_type).sort()).toEqual(
      [...AUDIT_EVENT_TYPES].sort(),
    );
  });

  it('every example matches the published schema shape', () => {
    for (const event of doc.examples) {
      expect(Object.keys(event).sort()).toEqual([...auditSchema.required].sort());
      expect(event.event_version).toBe(AUDIT_EVENT_VERSION);
      expect(event.event_id).toMatch(/^evt_[0-9a-f]{32}$/);
      expect(['accepted', 'refused', 'no_op']).toContain(event.outcome);
      expect(event.resulting_revision).toBeGreaterThanOrEqual(event.prior_revision);
    }
  });

  it('no example leaks anything sensitive', () => {
    for (const event of doc.examples) {
      expect(findSensitiveData(event)).toEqual([]);
    }
  });

  it('refusals and replays never advance the revision', () => {
    for (const event of doc.examples) {
      if (event.outcome === 'refused' || event.outcome === 'no_op') {
        expect(event.resulting_revision).toBe(event.prior_revision);
      }
    }
  });

  it('every accepted transition advances the revision by exactly one', () => {
    for (const event of doc.examples) {
      if (event.outcome === 'accepted') {
        expect(event.resulting_revision).toBe(event.prior_revision + 1);
      }
    }
  });

  it('every example is synthetic and names no real artifact', () => {
    for (const event of doc.examples) {
      expect(event.identity?.artifact_id).toBe('synthetic_fixture');
    }
    expect(JSON.stringify(doc)).not.toMatch(/token_dictionary|question_flow|knowledge_base/);
  });
});
