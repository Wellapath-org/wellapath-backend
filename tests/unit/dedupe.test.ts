import { DedupeStore } from '../../src/telemetry/dedupe';

describe('dedupe store', () => {
  it('reports an unseen event ID as new', () => {
    const store = new DedupeStore({ ttlMs: 1000, maxEntries: 100 });
    expect(store.seen('evt_1', 0)).toBe(false);
  });

  it('reports a repeat inside the TTL as seen', () => {
    const store = new DedupeStore({ ttlMs: 1000, maxEntries: 100 });
    store.seen('evt_1', 0);
    expect(store.seen('evt_1', 500)).toBe(true);
    expect(store.seen('evt_1', 999)).toBe(true);
  });

  it('lets an entry lapse once the TTL has passed', () => {
    const store = new DedupeStore({ ttlMs: 1000, maxEntries: 100 });
    store.seen('evt_1', 0);
    expect(store.seen('evt_1', 1001)).toBe(false);
  });

  it('keeps distinct IDs independent', () => {
    const store = new DedupeStore({ ttlMs: 1000, maxEntries: 100 });
    expect(store.seen('evt_1', 0)).toBe(false);
    expect(store.seen('evt_2', 0)).toBe(false);
    expect(store.seen('evt_1', 1)).toBe(true);
  });

  it('never exceeds its entry bound', () => {
    const store = new DedupeStore({ ttlMs: 60_000, maxEntries: 50 });
    for (let i = 0; i < 5000; i += 1) store.seen(`evt_${i}`, 0);
    expect(store.size()).toBeLessThanOrEqual(50);
  });

  it('evicts oldest-first when every entry is still live', () => {
    const store = new DedupeStore({ ttlMs: 60_000, maxEntries: 3 });
    store.seen('a', 0);
    store.seen('b', 0);
    store.seen('c', 0);
    store.seen('d', 0);

    // 'a' was evicted, so it looks new again; 'd' is remembered.
    expect(store.seen('a', 1)).toBe(false);
    expect(store.seen('d', 1)).toBe(true);
  });

  it('prefers sweeping expired entries over evicting live ones', () => {
    const store = new DedupeStore({ ttlMs: 1000, maxEntries: 2 });
    store.seen('old_1', 0);
    store.seen('old_2', 0);
    store.seen('fresh', 2000); // both old entries have expired by now

    expect(store.size()).toBeLessThanOrEqual(2);
    expect(store.seen('fresh', 2001)).toBe(true);
  });

  it('clears completely', () => {
    const store = new DedupeStore({ ttlMs: 1000, maxEntries: 10 });
    store.seen('evt_1', 0);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.seen('evt_1', 1)).toBe(false);
  });
});
