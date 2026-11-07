/**
 * Idempotency-Key handling for create endpoints (contract §1.2).
 *
 * Stores (account, method, route template, key) → (SHA-256 of the canonical request, status,
 * response) for 24 h. The canonical request is method + route template + path parameters + body
 * (SEC-006): the route template carries no ids, so without the path parameters a key reused on
 * another target (another account, post or space) would replay the first target's result and
 * silently skip the action. Same key + same request ⇒ replay with `Idempotent-Replayed: true`
 * (no rate limit, no duplicate notification); same key + different body or different target ⇒
 * 422 `idempotency_key_reused`; same key still in flight ⇒ 409 `idempotency_in_progress`. 429
 * and 5xx outcomes are not stored, so the client may retry.
 */
import { createHash } from 'crypto';
import { FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { ApiError, conflict, UUID, validation } from './http';

const TTL_HOURS = 24;

/** Canonical JSON: object keys sorted recursively, so key order does not change the hash. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/** SHA-256 of the canonical request: method, route template, path parameters and body. */
export const requestHash = (
  method: string,
  route: string,
  params: Record<string, unknown>,
  body: unknown,
): string =>
  createHash('sha256')
    .update(canonical({ method, route, params: params ?? {}, body: body ?? null }))
    .digest('hex');

export interface StoredResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type IdempotencyOutcome =
  | { kind: 'replay'; result: StoredResult }
  | {
      kind: 'fresh';
      complete: (result: StoredResult) => Promise<void>;
      abandon: () => Promise<void>;
    }
  | { kind: 'none' };

/** Reads and validates the header. `required` routes reject a missing key. */
export const idempotencyKey = (request: FastifyRequest, required: boolean): string | undefined => {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) {
    if (required) throw validation('Idempotency-Key', 'required');
    return undefined;
  }
  if (typeof raw !== 'string' || !UUID.test(raw.toLowerCase())) {
    throw validation('Idempotency-Key', 'format');
  }
  return raw.toLowerCase();
};

export class IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async begin(
    accountId: string,
    method: string,
    route: string,
    key: string | undefined,
    body: unknown,
    params: Record<string, unknown> = {},
  ): Promise<IdempotencyOutcome> {
    if (!key) return { kind: 'none' };
    const hash = requestHash(method, route, params, body);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await this.pool.query(
        `INSERT INTO idempotency_keys (account_id, method, route, key, request_hash)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING key`,
        [accountId, method, route, key, hash],
      );
      const where = [accountId, method, route, key];
      if (inserted.rowCount === 1) {
        return {
          kind: 'fresh',
          complete: async (result: StoredResult): Promise<void> => {
            if (result.status === 429 || result.status >= 500) {
              await this.pool.query(
                `DELETE FROM idempotency_keys
                  WHERE account_id = $1 AND method = $2 AND route = $3 AND key = $4`,
                where,
              );
              return;
            }
            await this.pool.query(
              `UPDATE idempotency_keys SET status_code = $5, response = $6, response_headers = $7
                WHERE account_id = $1 AND method = $2 AND route = $3 AND key = $4`,
              [
                ...where,
                result.status,
                JSON.stringify(result.body ?? null),
                JSON.stringify(result.headers ?? {}),
              ],
            );
          },
          abandon: async (): Promise<void> => {
            await this.pool.query(
              `DELETE FROM idempotency_keys
                WHERE account_id = $1 AND method = $2 AND route = $3 AND key = $4`,
              where,
            );
          },
        };
      }
      const { rows } = await this.pool.query<{
        request_hash: string;
        status_code: number | null;
        response: unknown;
        response_headers: Record<string, string> | null;
        expired: boolean;
      }>(
        `SELECT request_hash, status_code, response, response_headers,
                created_at < now() - make_interval(hours => $5) AS expired
           FROM idempotency_keys
          WHERE account_id = $1 AND method = $2 AND route = $3 AND key = $4`,
        [...where, TTL_HOURS],
      );
      const row = rows[0];
      if (!row) continue; // removed concurrently; try to claim it again
      if (row.expired) {
        await this.pool.query(
          `DELETE FROM idempotency_keys
            WHERE account_id = $1 AND method = $2 AND route = $3 AND key = $4`,
          where,
        );
        continue;
      }
      if (row.request_hash !== hash) throw new ApiError('idempotency_key_reused');
      if (row.status_code === null) throw conflict('idempotency_in_progress');
      return {
        kind: 'replay',
        result: {
          status: row.status_code,
          body: row.response,
          headers: row.response_headers ?? {},
        },
      };
    }
    throw conflict('idempotency_in_progress');
  }
}
