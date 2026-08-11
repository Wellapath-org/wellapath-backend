/**
 * Bounded, TTL-based de-duplication of event IDs.
 *
 * A mobile client flushing an offline queue will re-send events it is not sure were received.
 * The client-generated `event_id` lets the server drop the second copy.
 *
 * Deliberately in-memory and per-instance. It is a best-effort duplicate suppressor, not a
 * correctness guarantee: an event re-sent after the TTL, or to a different instance, will be
 * accepted twice. That trade is documented in the mobile contract so nobody depends on
 * exactly-once semantics. The alternative — a shared store — would mean persisting event IDs,
 * which is storage this feature does not otherwise need.
 *
 * Both the entry count and the TTL are bounded, so a hostile client cannot grow it without
 * limit.
 */
export interface DedupeStoreOptions {
  ttlMs: number;
  maxEntries: number;
}

export class DedupeStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly options: DedupeStoreOptions) {}

  /**
   * Records an event ID. Returns true if this ID has already been seen inside the TTL window,
   * in which case the caller should drop the event.
   */
  seen(eventId: string, nowMs: number): boolean {
    const expiresAt = this.entries.get(eventId);

    if (expiresAt !== undefined && expiresAt > nowMs) {
      return true;
    }

    // Either unseen or expired — (re)record it and move it to the end of the eviction order.
    if (expiresAt !== undefined) this.entries.delete(eventId);
    this.entries.set(eventId, nowMs + this.options.ttlMs);
    this.evictIfNeeded(nowMs);
    return false;
  }

  private evictIfNeeded(nowMs: number): void {
    if (this.entries.size <= this.options.maxEntries) return;

    // Sweep expired entries first; fall back to oldest-first eviction (Map preserves
    // insertion order) so the store can never exceed its bound.
    for (const [id, expiresAt] of this.entries) {
      if (this.entries.size <= this.options.maxEntries) return;
      if (expiresAt <= nowMs) this.entries.delete(id);
    }

    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }

  /** Current entry count. Exposed for tests and for the bounded-growth assertion. */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
