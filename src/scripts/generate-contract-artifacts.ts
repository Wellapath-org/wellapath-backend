/**
 * Writes the Mobile Engineering contract artifacts from `src/telemetry/contract.ts`.
 *
 *   npm run telemetry:contract         # regenerate
 *   npm run telemetry:contract:check   # regenerate and fail if anything changed
 *
 * The check variant runs in CI, so a change to the contract that is not accompanied by
 * regenerated artifacts fails the build. That is what keeps the published contract and the
 * enforced contract from drifting.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { TELEMETRY_CONTRACT_VERSION } from '../telemetry/contract';
import {
  buildAllowlistMatrix,
  buildClientTypes,
  buildEnvelopeJsonSchema,
  buildOpenApiDocument,
} from '../telemetry/json-schema';
import { logger } from '../utils/logger';

const OUTPUT_DIR = resolve(__dirname, '../../docs/contracts');
const MAJOR = TELEMETRY_CONTRACT_VERSION.split('.')[0];

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const artifacts: { file: string; contents: string }[] = [
  { file: `telemetry.v${MAJOR}.schema.json`, contents: asJson(buildEnvelopeJsonSchema()) },
  { file: `telemetry.v${MAJOR}.openapi.json`, contents: asJson(buildOpenApiDocument()) },
  { file: `telemetry.v${MAJOR}.allowlist.json`, contents: asJson(buildAllowlistMatrix()) },
  { file: `telemetry.v${MAJOR}.client.ts`, contents: buildClientTypes() },
];

const generate = (): void => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const { file, contents } of artifacts) {
    writeFileSync(resolve(OUTPUT_DIR, file), contents, 'utf8');
    logger.info({ file }, 'Wrote telemetry contract artifact');
  }
};

const check = (): void => {
  generate();
  try {
    // Scoped to the four files this script owns, NOT to OUTPUT_DIR as a whole: other contracts
    // (e.g. manifest.v1.schema.json) share that directory and have their own drift checks, so a
    // directory-wide diff would report an unrelated edit as a telemetry contract failure.
    const owned = artifacts.map(({ file }) => resolve(OUTPUT_DIR, file));
    execFileSync('git', ['diff', '--exit-code', '--', ...owned], { stdio: 'pipe' });
    logger.info('Telemetry contract artifacts are in sync with contract.ts');
  } catch {
    logger.error(
      'Telemetry contract artifacts are out of date. Run `npm run telemetry:contract` and ' +
        'commit the result.',
    );
    process.exit(1);
  }
};

if (process.argv.includes('--check')) {
  check();
} else {
  generate();
}
