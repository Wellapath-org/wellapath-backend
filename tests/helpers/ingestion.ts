/**
 * Test-only builders for ingestion envelopes.
 *
 * Everything here is synthetic scaffolding. The two real blocked candidates are read from the
 * committed manifest fixture rather than retyped, so a test can never quietly disagree with the
 * descriptor the repository actually holds.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ArtifactDescriptor, CandidateManifest, Environment } from '../../src/manifest/contract';
import {
  ArtifactIdentity,
  IngestionEnvelope,
  IngestionOperation,
  MANIFEST_SCHEMA_BYTE_COUNT,
  MANIFEST_SCHEMA_SHA256,
  REQUIRED_MANIFEST_CONTRACT_VERSION,
  INGESTION_ENVELOPE_VERSION,
} from '../../src/manifest/ingestion/contract';
import { KB_INTEGRATION_PINS } from '../../src/manifest/ingestion/pins';
import { AuditAuthority } from '../../src/manifest/registry/audit';

const fixturesDir = join(__dirname, '../fixtures/manifest');

export const loadManifest = (name: string): CandidateManifest =>
  JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as CandidateManifest;

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The two real blocked candidates, exactly as the repository holds them. */
export const blockedCandidate = (artifactId: string): ArtifactDescriptor => {
  const manifest = loadManifest('blocked-candidates.manifest.json');
  const descriptor = manifest.artifacts.find(entry => entry.artifact_id === artifactId);
  if (descriptor === undefined) throw new Error(`no blocked candidate ${artifactId}`);
  return clone(descriptor);
};

export const identityOf = (descriptor: ArtifactDescriptor): ArtifactIdentity => ({
  artifact_id: descriptor.artifact_id,
  artifact_version: descriptor.artifact_version,
  sha256: descriptor.sha256,
});

export interface EnvelopeOptions {
  descriptor: ArtifactDescriptor;
  operation?: IngestionOperation;
  environment?: Environment;
  planId?: string;
  trustMode?: 'production' | 'synthetic_test_only';
  synthetic?: boolean;
  idempotencyKey?: string;
  publicationRef?: string | null;
  activationRef?: string | null;
  rollbackRef?: string | null;
}

/** Builds a structurally sound envelope. Callers mutate the result to create negative cases. */
export const buildEnvelope = (options: EnvelopeOptions): IngestionEnvelope => {
  const descriptor = options.descriptor;
  const planId =
    options.planId ??
    (descriptor.artifact_id === 'question_flow'
      ? 'question_flow.ng.v1.1.dryrun'
      : 'token_dictionary.ng.v2.0.dryrun');
  const plan = KB_INTEGRATION_PINS.publication_plans[planId];

  return {
    envelope_version: INGESTION_ENVELOPE_VERSION,
    manifest_contract_version: REQUIRED_MANIFEST_CONTRACT_VERSION,
    manifest_schema_sha256: MANIFEST_SCHEMA_SHA256,
    manifest_schema_byte_count: MANIFEST_SCHEMA_BYTE_COUNT,
    provenance: {
      source_repository: KB_INTEGRATION_PINS.source_repository,
      source_commit: KB_INTEGRATION_PINS.source_commit,
      publication_plan_id: planId,
      publication_plan_sha256: plan?.sha256 ?? 'unknown',
      generator: 'test-harness',
      generator_version: '0.0.0',
    },
    descriptor,
    identity: identityOf(descriptor),
    byte_count: descriptor.byte_count,
    content_type: descriptor.content_type,
    object_key: descriptor.object_key,
    environment: options.environment ?? 'staging',
    requested_operation: options.operation ?? 'stage',
    authorizations: {
      publication_decision_ref: options.publicationRef ?? null,
      activation_decision_ref: options.activationRef ?? null,
      rollback_decision_ref: options.rollbackRef ?? null,
    },
    attestation: {
      trust_mode: options.trustMode ?? 'production',
      claimed_signed: false,
      signature_ref: null,
    },
    created_at: '2026-08-29T00:00:00Z',
    idempotency_key: options.idempotencyKey ?? 'test-idem-key-0001',
    predecessor: descriptor.predecessor
      ? {
          artifact_id: descriptor.artifact_id,
          artifact_version: descriptor.predecessor.artifact_version,
          sha256: descriptor.predecessor.sha256,
        }
      : null,
    rollback: null,
    synthetic: options.synthetic ?? false,
  };
};

/**
 * A synthetic, fully-governed descriptor used as the admissible base for negative mutations.
 * Artifact line `synthetic_fixture`, country `zz`: it cannot collide with any real object key,
 * and it authorizes nothing anywhere.
 */
export const syntheticDescriptor = (version = '1.0', digestSeed = 'a'): ArtifactDescriptor =>
  ({
    artifact_id: 'synthetic_fixture',
    artifact_version: version,
    schema_version: 'wellapath.artifact/1',
    content_type: 'application/json',
    sha256: `sha256:${digestSeed.repeat(64).slice(0, 64)}`,
    byte_count: 128,
    object_key: `synthetic_fixture.zz.v${version}.json`,
    release_status: 'published',
    activation_status: 'inactive',
    activation_authorized: true,
    activation_decision_ref: 'SYNTHETIC-ACT-001 (test fixture, authorizes nothing real)',
    target_environments: ['development'],
    publication_decision_ref: 'SYNTHETIC-PUB-001 (test fixture, authorizes nothing real)',
    approvals: {
      product: {
        required: true,
        status: 'granted',
        decision_ref: 'SYNTHETIC-PRODUCT-001 (test fixture)',
        approved_at: '2026-08-29T00:00:00Z',
        decision_scope: ['artifact_publication'],
      },
      clinical: { required: false, status: 'not_required', decision_ref: null, approved_at: null },
    },
    blockers: [],
    predecessor: null,
    rollback_target: null,
    created_at: '2026-08-29T00:00:00Z',
    published_at: '2026-08-29T00:00:00Z',
    deprecated: false,
    expires_at: null,
    country: 'zz',
    references: ['SYNTHETIC TEST FIXTURE — names no real object and authorizes nothing'],
  }) as unknown as ArtifactDescriptor;

/** An admissible synthetic envelope: the base every negative mutation starts from. */
export const syntheticEnvelope = (overrides: Partial<EnvelopeOptions> = {}): IngestionEnvelope =>
  buildEnvelope({
    descriptor: syntheticDescriptor(),
    operation: 'stage',
    environment: 'development',
    trustMode: 'synthetic_test_only',
    synthetic: true,
    idempotencyKey: 'synthetic-base-key-0001',
    publicationRef: 'SYNTHETIC-PUB-001 (test fixture)',
    activationRef: 'SYNTHETIC-ACT-001 (test fixture)',
    rollbackRef: 'SYNTHETIC-ROLLBACK-001 (test fixture)',
    ...overrides,
  });

export const testAuthority = (overrides: Partial<AuditAuthority> = {}): AuditAuthority => ({
  actor_ref: 'test-harness',
  publication_decision_ref: null,
  activation_decision_ref: null,
  rollback_decision_ref: null,
  ...overrides,
});
