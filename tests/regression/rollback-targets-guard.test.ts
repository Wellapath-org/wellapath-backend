/**
 * Rollback-target guard (WP-031 / WP-032).
 *
 * `/config` may only name an artifact whose exact (file, sha256) pair is either the active
 * version or a verified rollback target. It must never name a retired one:
 *
 * - `facilities.ng.v1.1.json` was deleted from R2 on 2026-09-29 (HTTP 404, withdrawn NHFR data);
 * - `kb.ng.v2.0.json`, `kb.ng.v2.1.json` and `rules.ng.v2.0.json` were edited in place after
 *   `/config` served them, so the served hash no longer matches the R2 bytes.
 *
 * This is intentionally not a "facilities >= 1.2" check: facilities 1.0 is a verified rollback
 * target (PR #40), and a version floor would block that sanctioned rollback.
 *
 * Source of truth: the knowledge-base `publication/published_artifacts_registry_v1.json` and
 * `docs/ROLLBACK_TARGETS.md` (KB PR #54). Keep the two lists below in sync with that registry.
 * Re-verified against R2 by anonymous GET on 2026-11-07 21:44Z.
 *
 * Limits: this guards code going forward. It cannot stop a Render "Rollback" to an old build,
 * because that old build does not contain this test. See `docs/OPERATIONS_RENDER_ROLLBACK.md`.
 * Live reachability of each URL is checked by `scripts/verify-live-artifacts.sh` (PR #45) and by
 * the runbook checklist, not here: unit tests do not use the network.
 */
import { RecordingSink, TestApp, createTestApp } from '../helpers/app';

/** Active versions and verified rollback targets: R2 bytes = hash `/config` served = repo. */
const ALLOWED: Record<string, Record<string, string>> = {
  token_dictionary: {
    'token_dictionary.ng.v1.1.json':
      'sha256:0cc47ad9537c0bd4c6ef3aec8f1931eb9b4c62103a8809d16544f94a90b5c019',
    'token_dictionary.ng.v1.0.json':
      'sha256:773006dee306a3b03312315134fe62d7abf1aa29baa1903a388854f34f24b76d',
  },
  knowledge_base: {
    'kb.ng.v2.4.json': 'sha256:6c00d8257f8417e86bd5e237630bf8a4623ad72e2e46b1b071dd447c067cec2b',
    'kb.ng.v2.3.json': 'sha256:cb0e43fc20bfab4351e123e73bc997d663469a36bca3222ec7fdbe5d7dc4e9f8',
    'kb.ng.v2.2.json': 'sha256:80c39e7e5187932a808e472db7c0a629b6feb73e0f7576bfc51685581d79b4e5',
  },
  rules: {
    'rules.ng.v2.2.json': 'sha256:1d27e854cba95b179577a88f92445400f494a7fe8e6a53a60fcaa98b3870d1c4',
    'rules.ng.v2.1.json': 'sha256:57da3ff543c0e2e948c196930de75b40f70edf7d40b6ef4e90b8ccbe10481b79',
  },
  facilities: {
    'facilities.ng.v1.2.json':
      'sha256:94f162e492fa91f7d9d3cf2ca33fcf0598a031a2510aa900aa717a581bdb7788',
    'facilities.ng.v1.0.json':
      'sha256:1c7b939199ab4465156f4cb336910eea120fcaa70f8b1c0743fc9f7a7c03009e',
  },
};

/** Retired: never serve, never roll back to. Hashes are the ones `/config` originally served. */
const RETIRED: { file: string; served_hash: string }[] = [
  {
    file: 'facilities.ng.v1.1.json',
    served_hash: 'sha256:25684c714367abf2f3c305c8a5597b5f7eb0d11baaf658c5b9e2f8f5e2982398',
  },
  {
    file: 'kb.ng.v2.0.json',
    served_hash: 'sha256:b8a3c19e251453ffb37693dab117a11b4a9daf5b5a331b4758e5a0cc8c598db9',
  },
  {
    file: 'kb.ng.v2.1.json',
    served_hash: 'sha256:e5d9fd82669b0ac52b5ed0626b4f94ebd043c520c1d4601e42bf2926e0abc515',
  },
  {
    file: 'rules.ng.v2.0.json',
    served_hash: 'sha256:b969b084974f60d76322952c85a8fffe9b2b0a0d73252d518b59078765e5f5e3',
  },
];

type Artifact = { version: string; url: string; hash: string };

describe('GET /config names only active or verified rollback-target artifacts', () => {
  let app: TestApp;
  let artifacts: Record<string, Artifact>;

  beforeAll(async () => {
    app = await createTestApp({ telemetrySink: new RecordingSink() });
    artifacts = (await app.server.inject({ method: 'GET', url: '/config' })).json().artifacts;
  });

  afterAll(async () => app.close());

  it('serves no retired file and no retired hash', () => {
    for (const artifact of Object.values(artifacts)) {
      const file = artifact.url.split('/').pop();
      for (const retired of RETIRED) {
        expect(file).not.toBe(retired.file);
        expect(artifact.hash).not.toBe(retired.served_hash);
      }
    }
  });

  it.each(Object.keys(ALLOWED))('serves %s as an allowed (file, hash) pair', name => {
    const artifact = artifacts[name];
    expect(artifact).toBeDefined();
    const file = artifact.url.split('/').pop() as string;
    expect(Object.keys(ALLOWED[name])).toContain(file);
    expect(artifact.hash).toBe(ALLOWED[name][file]);
    expect(file).toBe(`${file.split('.ng.v')[0]}.ng.v${artifact.version}.json`);
  });

  it('serves no artifact this guard does not know about', () => {
    expect(Object.keys(artifacts).sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});
