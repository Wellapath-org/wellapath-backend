/**
 * Operational metrics registry.
 *
 * Low cardinality is enforced structurally, not by convention: every counter declares the
 * closed set of label values it will accept, and anything outside that set is folded into
 * `other`. It is therefore not possible to introduce an event ID, session ID, facility ID,
 * article ID, IP address or user agent as a metric label from anywhere in the codebase.
 *
 * No metric here carries a symptom, answer, condition, score, red-flag or precise-location
 * label, and none is user-level.
 */
import { ALL_REJECTION_REASONS, RejectionReason } from './reason-codes';
import { EVENT_NAMES } from './contract';

/** Latency buckets in milliseconds, upper-bound inclusive. */
const LATENCY_BUCKETS_MS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];

/** Routes that may appear as a metric label. Anything else becomes `other`. */
export const METRIC_ROUTE_LABELS: readonly string[] = [
  '/health',
  '/version',
  '/config',
  '/v1/telemetry/events',
  '/internal/metrics',
];

const OTHER = 'other';

interface Histogram {
  count: number;
  sumMs: number;
  buckets: number[];
}

const createHistogram = (): Histogram => ({
  count: 0,
  sumMs: 0,
  buckets: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
});

const observe = (histogram: Histogram, valueMs: number): void => {
  histogram.count += 1;
  histogram.sumMs += valueMs;
  const index = LATENCY_BUCKETS_MS.findIndex(bound => valueMs <= bound);
  histogram.buckets[index === -1 ? LATENCY_BUCKETS_MS.length : index] += 1;
};

const histogramSnapshot = (histogram: Histogram): Record<string, unknown> => {
  const buckets: Record<string, number> = {};
  LATENCY_BUCKETS_MS.forEach((bound, index) => {
    buckets[`le_${bound}`] = histogram.buckets[index];
  });
  buckets.le_inf = histogram.buckets[LATENCY_BUCKETS_MS.length];
  return {
    count: histogram.count,
    sum_ms: Number(histogram.sumMs.toFixed(3)),
    buckets,
  };
};

/** A counter whose label values are fixed at construction time. */
class LabelledCounter {
  private readonly values: Map<string, number>;

  constructor(allowedLabels: readonly string[]) {
    this.values = new Map(allowedLabels.map(label => [label, 0]));
    this.values.set(OTHER, 0);
  }

  increment(label: string, by = 1): void {
    const key = this.values.has(label) ? label : OTHER;
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  reset(): void {
    for (const key of this.values.keys()) this.values.set(key, 0);
  }
}

/** A plain counter with no labels. */
class Counter {
  private value = 0;

  increment(by = 1): void {
    this.value += by;
  }

  snapshot(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

const REQUEST_OUTCOMES: readonly string[] = [
  'accepted',
  'rejected',
  'disabled',
  'rate_limited',
  'error',
];

const STATUS_CLASSES: readonly string[] = ['2xx', '3xx', '4xx', '5xx'];

class MetricsRegistry {
  /** Accepted events, by allowlisted event name. 12 possible values. */
  readonly telemetryEventsAccepted = new LabelledCounter(EVENT_NAMES);
  /** Rejected events, by safe rejection reason. Closed set. */
  readonly telemetryEventsRejected = new LabelledCounter(ALL_REJECTION_REASONS);
  /** Events discarded as duplicates of an already-seen event ID. */
  readonly telemetryEventsDuplicate = new Counter();
  /** Events dropped without delivery (sink exhausted its retries, or backpressure). */
  readonly telemetryEventsDropped = new Counter();
  /** Telemetry requests, by outcome. */
  readonly telemetryRequests = new LabelledCounter(REQUEST_OUTCOMES);
  /** Sink/export delivery failures after all retries. */
  readonly telemetrySinkFailures = new Counter();
  /** Individual delivery retry attempts. */
  readonly telemetrySinkRetries = new Counter();
  /** Telemetry endpoint latency. */
  readonly telemetryRequestDurationMs = createHistogram();

  /** Backend-wide request counters, by route and status class. */
  readonly httpRequests = new LabelledCounter(
    METRIC_ROUTE_LABELS.flatMap(route => STATUS_CLASSES.map(status => `${route}|${status}`)),
  );
  /** Backend-wide error counter (5xx responses). */
  readonly httpServerErrors = new Counter();
  /** Backend-wide request latency, by route. */
  private readonly httpDurations = new Map<string, Histogram>(
    METRIC_ROUTE_LABELS.concat(OTHER).map(route => [route, createHistogram()]),
  );

  observeTelemetryDuration(durationMs: number): void {
    observe(this.telemetryRequestDurationMs, durationMs);
  }

  observeHttpRequest(route: string, statusCode: number, durationMs: number): void {
    const routeLabel = METRIC_ROUTE_LABELS.includes(route) ? route : OTHER;
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    const classLabel = STATUS_CLASSES.includes(statusClass) ? statusClass : OTHER;
    this.httpRequests.increment(`${routeLabel}|${classLabel}`);
    if (statusCode >= 500) this.httpServerErrors.increment();
    const histogram = this.httpDurations.get(routeLabel);
    if (histogram) observe(histogram, durationMs);
  }

  incrementRejection(reason: RejectionReason, by = 1): void {
    this.telemetryEventsRejected.increment(reason, by);
  }

  snapshot(): Record<string, unknown> {
    const httpLatency: Record<string, unknown> = {};
    for (const [route, histogram] of this.httpDurations) {
      httpLatency[route] = histogramSnapshot(histogram);
    }

    return {
      telemetry: {
        events_accepted_total: this.telemetryEventsAccepted.snapshot(),
        events_rejected_total: this.telemetryEventsRejected.snapshot(),
        events_duplicate_total: this.telemetryEventsDuplicate.snapshot(),
        events_dropped_total: this.telemetryEventsDropped.snapshot(),
        requests_total: this.telemetryRequests.snapshot(),
        sink_failures_total: this.telemetrySinkFailures.snapshot(),
        sink_retries_total: this.telemetrySinkRetries.snapshot(),
        request_duration_ms: histogramSnapshot(this.telemetryRequestDurationMs),
      },
      http: {
        requests_total: this.httpRequests.snapshot(),
        server_errors_total: this.httpServerErrors.snapshot(),
        request_duration_ms: httpLatency,
      },
    };
  }

  /** Test helper — resets every counter and histogram in place. */
  reset(): void {
    this.telemetryEventsAccepted.reset();
    this.telemetryEventsRejected.reset();
    this.telemetryEventsDuplicate.reset();
    this.telemetryEventsDropped.reset();
    this.telemetryRequests.reset();
    this.telemetrySinkFailures.reset();
    this.telemetrySinkRetries.reset();
    this.httpRequests.reset();
    this.httpServerErrors.reset();
    this.telemetryRequestDurationMs.count = 0;
    this.telemetryRequestDurationMs.sumMs = 0;
    this.telemetryRequestDurationMs.buckets.fill(0);
    for (const histogram of this.httpDurations.values()) {
      histogram.count = 0;
      histogram.sumMs = 0;
      histogram.buckets.fill(0);
    }
  }
}

/** Process-wide registry. In-memory and per-instance, like any counter set on this stack. */
export const metrics = new MetricsRegistry();

export type { MetricsRegistry };
