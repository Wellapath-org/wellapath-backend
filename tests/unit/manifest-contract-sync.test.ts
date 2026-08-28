/**
 * Drift check between the TypeScript contract (source of truth) and the published JSON Schema
 * in `docs/contracts/manifest.v1.schema.json`. Follows the telemetry-contract precedent: the
 * document handed to other teams must be provably in sync with the code that enforces it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ACTIVATION_STATUSES,
  APPROVAL_STATUSES,
  ENVIRONMENTS,
  MANIFEST_CONTRACT_VERSION,
  OPTIONAL_DESCRIPTOR_KEYS,
  RELEASE_STATUSES,
  REQUIRED_DESCRIPTOR_KEYS,
  SUPPORTED_ARTIFACT_SCHEMAS,
  SUPPORTED_CONTENT_TYPES,
} from '../../src/manifest/contract';

interface SchemaDocument {
  contract_version: string;
  required: string[];
  properties: Record<string, unknown>;
  definitions: {
    approval_record: { properties: { status: { enum: string[] } } };
    artifact_descriptor: {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
    };
  };
}

const schema = JSON.parse(
  readFileSync(join(__dirname, '../../docs/contracts/manifest.v1.schema.json'), 'utf8'),
) as SchemaDocument;

describe('manifest JSON Schema stays in sync with the TypeScript contract', () => {
  it('carries the same contract version', () => {
    expect(schema.contract_version).toBe(MANIFEST_CONTRACT_VERSION);
  });

  it('requires exactly the same descriptor fields', () => {
    expect([...schema.definitions.artifact_descriptor.required].sort()).toEqual(
      [...REQUIRED_DESCRIPTOR_KEYS].sort(),
    );
  });

  it('permits exactly the same descriptor fields and nothing more', () => {
    const schemaKeys = Object.keys(schema.definitions.artifact_descriptor.properties).sort();
    const contractKeys = [...REQUIRED_DESCRIPTOR_KEYS, ...OPTIONAL_DESCRIPTOR_KEYS].sort();
    expect(schemaKeys).toEqual(contractKeys);
    expect(schema.definitions.artifact_descriptor.additionalProperties).toBe(false);
  });

  it('agrees on every enum', () => {
    const properties = schema.definitions.artifact_descriptor.properties;
    expect(properties.release_status.enum).toEqual([...RELEASE_STATUSES]);
    expect(properties.activation_status.enum).toEqual([...ACTIVATION_STATUSES]);
    expect(properties.schema_version.enum).toEqual([...SUPPORTED_ARTIFACT_SCHEMAS]);
    expect(properties.content_type.enum).toEqual([...SUPPORTED_CONTENT_TYPES]);
    expect(properties.target_environments.items?.enum).toEqual([...ENVIRONMENTS]);
    expect(schema.definitions.approval_record.properties.status.enum).toEqual([
      ...APPROVAL_STATUSES,
    ]);
  });

  it('declares the manifest top level closed', () => {
    expect(Object.keys(schema.properties).sort()).toEqual([
      'artifacts',
      'generated_at',
      'manifest_version',
      'required_features',
    ]);
  });
});
