/**
 * The shared display-name boundary cases (founder decision 2026-11-08, contract §7.2), read from
 * the pinned OpenAPI copy (`ProfileUpdate.display_name`, `x-wellapath-display-name-cases`). The
 * mobile client's tests read the same list from its byte-identical copy, so the two
 * implementations always run one list.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

export interface DisplayNameCase {
  input: string;
  /** The value kept and returned, when the name is accepted. */
  stored?: string;
  /** The `details.rule` of the 400 `validation_failed`, when it is refused. */
  rule?: string;
}

const spec = parse(
  readFileSync(join(__dirname, '../../docs/community/community_api_v1.openapi.yaml'), 'utf8'),
) as {
  components: {
    schemas: {
      ProfileUpdate: {
        properties: { display_name: { 'x-wellapath-display-name-cases': DisplayNameCase[] } };
      };
    };
  };
};

export const DISPLAY_NAME_CASES: DisplayNameCase[] =
  spec.components.schemas.ProfileUpdate.properties.display_name['x-wellapath-display-name-cases'];
