/** ADR-001 B4: the latency gate arithmetic (the measurement itself runs on Render Frankfurt). */
import { evaluateGate, LatencySample, percentile } from '../../src/community/latency-gate';

const sample = (connectP95: number, queryP95: number, failures = 0): LatencySample => ({
  runs: 100,
  failures,
  serverVersion: '18.6',
  connect: { p50: connectP95 / 2, p95: connectP95 },
  query: { p50: queryP95 / 2, p95: queryP95 },
});

describe('B4 latency gate', () => {
  it('nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
  });

  it.each([
    [149.9, 19.9, true, true],
    [150, 19.9, false, true],
    [149.9, 20, true, false],
    [1090, 190, false, false], // measured from a Mac to Frankfurt, 2026-11-07
  ])('connect p95 %p ms, query p95 %p ms', (c, q, connectPass, queryPass) => {
    expect(evaluateGate(sample(c, q))).toEqual({
      pass: connectPass && queryPass,
      connectPass,
      queryPass,
    });
  });

  it('any failed connection fails the gate', () => {
    expect(evaluateGate(sample(5, 1, 1)).pass).toBe(false);
  });
});
