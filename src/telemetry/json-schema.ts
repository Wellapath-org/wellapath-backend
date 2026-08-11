/**
 * Derives the JSON Schema, OpenAPI document, TypeScript client types and allowlist matrix from
 * `contract.ts`.
 *
 * Everything Mobile Engineering consumes is generated from the same declarations the server
 * validates against, so the published contract cannot drift from the enforced one. CI
 * regenerates and fails if the committed artifacts differ (see `.github/workflows/ci.yml`).
 */
import {
  APP_CONTEXT_SPEC,
  COMMON_EVENT_SPEC,
  ENVELOPE_SPEC,
  EVENT_NAMES,
  EVENT_SPECS,
  FieldSpec,
  FieldSpecMap,
  LIMITS,
  TELEMETRY_CONTRACT_VERSION,
} from './contract';
import { ALL_REJECTION_REASONS, EVENT_STATUS } from './reason-codes';

export const TELEMETRY_ENDPOINT_PATH = '/v1/telemetry/events';

type JsonSchema = Record<string, unknown>;

const fieldToJsonSchema = (spec: FieldSpec): JsonSchema => {
  switch (spec.kind) {
    case 'enum':
      return { type: 'string', enum: [...spec.values], description: spec.description };
    case 'string':
      return {
        type: 'string',
        maxLength: spec.maxLength,
        pattern: `^(?:${spec.pattern})$`,
        description: spec.description,
      };
    case 'integer':
      return {
        type: 'integer',
        minimum: spec.min,
        maximum: spec.max,
        description: spec.description,
      };
    case 'boolean':
      return { type: 'boolean', description: spec.description };
  }
};

const specMapToJsonSchema = (specs: FieldSpecMap): JsonSchema => {
  const properties: JsonSchema = {};
  const required: string[] = [];

  for (const [field, spec] of Object.entries(specs)) {
    properties[field] = fieldToJsonSchema(spec);
    if (spec.required) required.push(field);
  }

  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
};

const eventSchemaId = (eventName: string): string => `Event_${eventName}`;

/** JSON Schema (draft 2020-12) for the request envelope. */
export const buildEnvelopeJsonSchema = (): JsonSchema => {
  const definitions: JsonSchema = {
    AppContext: specMapToJsonSchema(APP_CONTEXT_SPEC),
  };

  for (const eventName of EVENT_NAMES) {
    const spec = EVENT_SPECS[eventName];
    const merged: FieldSpecMap = { ...COMMON_EVENT_SPEC, ...spec.properties };
    const schema = specMapToJsonSchema(merged) as JsonSchema & {
      properties: Record<string, JsonSchema>;
    };
    // Pin the discriminator to this branch.
    schema.properties.event_name = {
      type: 'string',
      const: eventName,
      description: COMMON_EVENT_SPEC.event_name.description,
    };
    schema.title = eventName;
    schema.description = spec.description;
    definitions[eventSchemaId(eventName)] = schema;
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://wellapath.org/schemas/telemetry/v${TELEMETRY_CONTRACT_VERSION}/envelope.json`,
    title: 'WellaPathTelemetryEnvelope',
    description:
      `WellaPath privacy-safe product telemetry, contract version ${TELEMETRY_CONTRACT_VERSION}. ` +
      'Every property is allowlisted. Unknown events and unknown properties are rejected.',
    type: 'object',
    additionalProperties: false,
    required: ['contract_version', 'sent_at', 'app', 'events'],
    properties: {
      contract_version: fieldToJsonSchema(ENVELOPE_SPEC.contract_version),
      sent_at: fieldToJsonSchema(ENVELOPE_SPEC.sent_at),
      app: { $ref: '#/$defs/AppContext' },
      events: {
        type: 'array',
        minItems: LIMITS.minEventsPerBatch,
        maxItems: LIMITS.maxEventsPerBatch,
        description: 'Batch of events. Each must match exactly one allowlisted event schema.',
        items: {
          oneOf: EVENT_NAMES.map(name => ({ $ref: `#/$defs/${eventSchemaId(name)}` })),
        },
      },
    },
    $defs: definitions,
  };
};

/** JSON Schema for the 202 response body. */
export const buildResponseJsonSchema = (): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: ['contract_version', 'received', 'accepted', 'rejected', 'duplicates', 'results'],
  properties: {
    contract_version: { type: 'string' },
    received: { type: 'integer', description: 'Number of events in the submitted batch.' },
    accepted: { type: 'integer', description: 'Events accepted and queued for delivery.' },
    rejected: { type: 'integer', description: 'Events refused. Do not retry these.' },
    duplicates: {
      type: 'integer',
      description: 'Events discarded as duplicates of an already-seen event_id.',
    },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'status'],
        properties: {
          index: { type: 'integer', description: 'Position in the submitted events array.' },
          status: { type: 'string', enum: Object.values(EVENT_STATUS) },
          reason: {
            type: 'string',
            enum: [...ALL_REJECTION_REASONS],
            description: 'Fixed rejection reason code. Never contains submitted content.',
          },
          field: {
            type: 'string',
            description:
              'Allowlisted field name the rejection relates to. Absent when the offending ' +
              'key was not an allowlisted name — client-supplied keys are never echoed.',
          },
        },
      },
    },
  },
});

/** JSON Schema for the error envelope shared with the rest of the service. */
export const buildErrorJsonSchema = (): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['statusCode', 'message'],
      properties: {
        statusCode: { type: 'integer' },
        message: {
          type: 'string',
          description: 'Generic, non-sensitive. Never quotes submitted content.',
        },
        reason_code: { type: 'string', enum: [...ALL_REJECTION_REASONS] },
      },
    },
  },
});

/** OpenAPI 3.1 document covering the telemetry contract only. */
export const buildOpenApiDocument = (): JsonSchema => {
  const envelope = buildEnvelopeJsonSchema() as JsonSchema & { $defs: JsonSchema };
  const { $defs, ...envelopeWithoutDefs } = envelope;

  // Re-point internal references at the OpenAPI components location.
  const repoint = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(repoint);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] =
          key === '$ref' && typeof item === 'string'
            ? item.replace('#/$defs/', '#/components/schemas/')
            : repoint(item);
      }
      return out;
    }
    return value;
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'WellaPath Telemetry Intake',
      version: TELEMETRY_CONTRACT_VERSION,
      description:
        'Privacy-safe product telemetry intake for the WellaPath mobile client (I1 / W1).\n\n' +
        'SCOPE: this document covers the telemetry contract only. The existing `/health`, ' +
        '`/version` and `/config` endpoints are unchanged by this work and are deliberately ' +
        'not redefined here — `/config` remains the mobile bootstrap contract described in ' +
        'docs/DEPLOYMENT.md.\n\n' +
        'No symptom, answer, clinical narrative, condition prediction, score, red-flag match, ' +
        'urgency, precise location, identity or credential value is accepted by this API.',
    },
    servers: [
      {
        url: 'https://wellapath-backend-staging.onrender.com',
        description: 'Staging',
      },
    ],
    paths: {
      [TELEMETRY_ENDPOINT_PATH]: {
        post: {
          operationId: 'submitTelemetryEvents',
          summary: 'Submit a batch of allowlisted product telemetry events',
          description:
            'Accepts 1–' +
            `${LIMITS.maxEventsPerBatch} events per request, up to ${LIMITS.maxBodyBytes} bytes. ` +
            'No authentication. Envelope-level failures reject the whole request; event-level ' +
            'failures reject only that event and are permanent — do not retry them.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: repoint(envelopeWithoutDefs) },
            },
          },
          responses: {
            '202': {
              description:
                'Envelope accepted. Individual events may still have been rejected or ' +
                'de-duplicated — inspect `results`.',
              content: { 'application/json': { schema: buildResponseJsonSchema() } },
            },
            '400': {
              description: 'Envelope rejected. Permanent — do not retry unchanged.',
              content: { 'application/json': { schema: buildErrorJsonSchema() } },
            },
            '413': {
              description: 'Body exceeds the size limit. Permanent — split the batch.',
              content: { 'application/json': { schema: buildErrorJsonSchema() } },
            },
            '415': {
              description: 'Content-Type must be application/json.',
              content: { 'application/json': { schema: buildErrorJsonSchema() } },
            },
            '429': {
              description: 'Rate limited. Retryable with backoff.',
              content: { 'application/json': { schema: buildErrorJsonSchema() } },
            },
            '503': {
              description:
                'Telemetry intake is disabled by configuration. Discard the batch and stop ' +
                'sending for the remainder of the session.',
              content: { 'application/json': { schema: buildErrorJsonSchema() } },
            },
          },
        },
      },
      '/internal/metrics': {
        get: {
          operationId: 'getOperationalMetrics',
          summary: 'Operational metrics snapshot (counts and latency histograms only)',
          responses: {
            '200': {
              description: 'Metrics snapshot.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
    components: { schemas: repoint($defs) },
  };
};

/** Machine-readable allowlist matrix, including the privacy class of every property. */
export const buildAllowlistMatrix = (): JsonSchema => {
  const describe = (specs: FieldSpecMap): unknown[] =>
    Object.entries(specs).map(([field, spec]) => ({
      field,
      type: spec.kind,
      required: spec.required,
      privacy_class: spec.privacy,
      ...(spec.kind === 'enum' ? { allowed_values: [...spec.values] } : {}),
      ...(spec.kind === 'string' ? { max_length: spec.maxLength, pattern: spec.pattern } : {}),
      ...(spec.kind === 'integer' ? { minimum: spec.min, maximum: spec.max } : {}),
      description: spec.description,
    }));

  return {
    contract_version: TELEMETRY_CONTRACT_VERSION,
    limits: LIMITS,
    envelope: describe(ENVELOPE_SPEC),
    app_context: describe(APP_CONTEXT_SPEC),
    common_event_fields: describe(COMMON_EVENT_SPEC),
    events: EVENT_NAMES.map(name => ({
      event_name: name,
      description: EVENT_SPECS[name].description,
      privacy_note: EVENT_SPECS[name].privacyNote,
      properties: describe(EVENT_SPECS[name].properties),
    })),
    rejection_reason_codes: [...ALL_REJECTION_REASONS],
  };
};

/* -------------------------------------------------------------------------------------------- */
/* TypeScript client types                                                                        */
/* -------------------------------------------------------------------------------------------- */

const tsType = (spec: FieldSpec): string => {
  switch (spec.kind) {
    case 'enum':
      return spec.values.map(value => `'${value}'`).join(' | ');
    case 'string':
      return 'string';
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
  }
};

const pascalCase = (value: string): string =>
  value
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const renderInterface = (name: string, specs: FieldSpecMap, extraDoc?: string): string => {
  const lines: string[] = [];
  if (extraDoc) lines.push(`/** ${extraDoc} */`);
  lines.push(`export interface ${name} {`);
  for (const [field, spec] of Object.entries(specs)) {
    lines.push(`  /** ${spec.description} (privacy: ${spec.privacy}) */`);
    lines.push(`  ${field}${spec.required ? '' : '?'}: ${tsType(spec)};`);
  }
  lines.push('}');
  return lines.join('\n');
};

/** Generated TypeScript client types for any TypeScript consumer of the contract. */
export const buildClientTypes = (): string => {
  const blocks: string[] = [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' *',
    ' * Regenerate with `npm run telemetry:contract` in the wellapath-backend repository.',
    ` * Telemetry contract version ${TELEMETRY_CONTRACT_VERSION}.`,
    ' *',
    ' * These types describe exactly what the server accepts. Anything not declared here is',
    ' * rejected at the boundary.',
    ' */',
    '',
    `export const TELEMETRY_CONTRACT_VERSION = '${TELEMETRY_CONTRACT_VERSION}';`,
    `export const TELEMETRY_ENDPOINT_PATH = '${TELEMETRY_ENDPOINT_PATH}';`,
    `export const TELEMETRY_MAX_EVENTS_PER_BATCH = ${LIMITS.maxEventsPerBatch};`,
    `export const TELEMETRY_MAX_BODY_BYTES = ${LIMITS.maxBodyBytes};`,
    '',
    `export type TelemetryEventName =\n${EVENT_NAMES.map(n => `  | '${n}'`).join('\n')};`,
    '',
    renderInterface('TelemetryAppContext', APP_CONTEXT_SPEC, 'Coarse app/runtime context.'),
    '',
  ];

  for (const eventName of EVENT_NAMES) {
    const spec = EVENT_SPECS[eventName];
    const merged: FieldSpecMap = { ...COMMON_EVENT_SPEC, ...spec.properties };
    const withPinnedName: FieldSpecMap = {
      ...merged,
      event_name: {
        kind: 'enum',
        values: [eventName],
        required: true,
        privacy: 'operational',
        description: spec.description,
      },
    };
    blocks.push(
      renderInterface(`${pascalCase(eventName)}Event`, withPinnedName, spec.privacyNote),
      '',
    );
  }

  blocks.push(
    `export type TelemetryEvent =\n${EVENT_NAMES.map(n => `  | ${pascalCase(n)}Event`).join('\n')};`,
    '',
    '/** Request envelope. */',
    'export interface TelemetryEnvelope {',
    `  contract_version: '${TELEMETRY_CONTRACT_VERSION}';`,
    '  /** ISO-8601 UTC, e.g. 2026-08-11T09:01:14.639Z */',
    '  sent_at: string;',
    '  app: TelemetryAppContext;',
    '  events: TelemetryEvent[];',
    '}',
    '',
    `export type TelemetryEventStatus =\n${Object.values(EVENT_STATUS)
      .map(s => `  | '${s}'`)
      .join('\n')};`,
    '',
    `export type TelemetryRejectionReason =\n${ALL_REJECTION_REASONS.map(r => `  | '${r}'`).join(
      '\n',
    )};`,
    '',
    '/** Per-event outcome returned in the 202 response. */',
    'export interface TelemetryEventResult {',
    '  index: number;',
    '  status: TelemetryEventStatus;',
    '  reason?: TelemetryRejectionReason;',
    '  /** Allowlisted field name only. Client-supplied keys are never echoed. */',
    '  field?: string;',
    '}',
    '',
    '/** 202 response body. */',
    'export interface TelemetryAcceptedResponse {',
    '  contract_version: string;',
    '  received: number;',
    '  accepted: number;',
    '  rejected: number;',
    '  duplicates: number;',
    '  results: TelemetryEventResult[];',
    '}',
    '',
    '/** Error response body, shared with the rest of the service. */',
    'export interface TelemetryErrorResponse {',
    '  error: {',
    '    statusCode: number;',
    '    message: string;',
    '    reason_code?: TelemetryRejectionReason;',
    '  };',
    '}',
    '',
  );

  return blocks.join('\n');
};
