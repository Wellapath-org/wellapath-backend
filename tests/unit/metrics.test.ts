import { EVENT_NAMES } from '../../src/telemetry/contract';
import { metrics, METRIC_ROUTE_LABELS } from '../../src/telemetry/metrics';
import { ALL_REJECTION_REASONS, REJECTION_REASONS } from '../../src/telemetry/reason-codes';

describe('metrics registry', () => {
  beforeEach(() => metrics.reset());

  it('counts accepted events by allowlisted event name', () => {
    metrics.telemetryEventsAccepted.increment('app_open');
    metrics.telemetryEventsAccepted.increment('app_open');
    metrics.telemetryEventsAccepted.increment('facility_view');

    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    expect(snapshot.events_accepted_total.app_open).toBe(2);
    expect(snapshot.events_accepted_total.facility_view).toBe(1);
  });

  it('pre-declares every allowlisted event name as a label', () => {
    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    for (const name of EVENT_NAMES) {
      expect(snapshot.events_accepted_total).toHaveProperty(name);
    }
  });

  it('counts rejections by safe reason code', () => {
    metrics.incrementRejection(REJECTION_REASONS.UNKNOWN_EVENT);
    metrics.incrementRejection(REJECTION_REASONS.PROHIBITED_FIELD);

    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    expect(snapshot.events_rejected_total.unknown_event).toBe(1);
    expect(snapshot.events_rejected_total.prohibited_field).toBe(1);
  });

  it('exposes only the closed reason-code label set', () => {
    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    const labels = Object.keys(snapshot.events_rejected_total);
    expect(new Set(labels)).toEqual(new Set([...ALL_REJECTION_REASONS, 'other']));
  });

  /**
   * The point of the structural guard: a caller cannot introduce a high-cardinality label even
   * by passing one in.
   */
  it('folds any unrecognised label into `other`', () => {
    metrics.telemetryEventsAccepted.increment('evt_0f8c21ab9d3e4f77'); // an event ID
    metrics.telemetryEventsAccepted.increment('sess_0123456789abcdef'); // a session ID
    metrics.telemetryEventsAccepted.increment('203.0.113.42'); // an IP address

    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, number>>;
    expect(snapshot.events_accepted_total.other).toBe(3);
    expect(Object.keys(snapshot.events_accepted_total)).not.toContain('203.0.113.42');
  });

  it('never grows its label set at runtime', () => {
    const before = Object.keys(
      (metrics.snapshot().telemetry as Record<string, Record<string, number>>)
        .events_accepted_total,
    ).length;

    for (let i = 0; i < 1000; i += 1) metrics.telemetryEventsAccepted.increment(`facility_${i}`);

    const after = Object.keys(
      (metrics.snapshot().telemetry as Record<string, Record<string, number>>)
        .events_accepted_total,
    ).length;

    expect(after).toBe(before);
  });

  it('records HTTP requests against the route pattern, not the URL', () => {
    metrics.observeHttpRequest('/config', 200, 4);
    metrics.observeHttpRequest('/config?leak=6.5244,3.3792', 200, 4);

    const http = metrics.snapshot().http as Record<string, Record<string, number>>;
    expect(http.requests_total['/config|2xx']).toBe(1);
    expect(JSON.stringify(http)).not.toContain('6.5244');
    expect(http.requests_total.other).toBe(1);
  });

  it('counts 5xx responses as server errors', () => {
    metrics.observeHttpRequest('/health', 503, 2);
    metrics.observeHttpRequest('/health', 200, 2);

    const http = metrics.snapshot().http as Record<string, number | Record<string, number>>;
    expect(http.server_errors_total).toBe(1);
  });

  it('declares a bounded route label set', () => {
    expect(METRIC_ROUTE_LABELS).toContain('/v1/telemetry/events');
    expect(METRIC_ROUTE_LABELS.length).toBeLessThan(20);
  });

  it('records latency into fixed histogram buckets', () => {
    metrics.observeTelemetryDuration(3);
    metrics.observeTelemetryDuration(3000);

    const snapshot = metrics.snapshot().telemetry as Record<string, Record<string, unknown>>;
    const histogram = snapshot.request_duration_ms as {
      count: number;
      sum_ms: number;
      buckets: Record<string, number>;
    };

    expect(histogram.count).toBe(2);
    expect(histogram.sum_ms).toBeCloseTo(3003);
    expect(histogram.buckets.le_5).toBe(1);
    expect(histogram.buckets.le_inf).toBe(1);
  });

  it('contains no clinical, location or user-level label anywhere in a snapshot', () => {
    metrics.telemetryEventsAccepted.increment('assessment_complete');
    metrics.incrementRejection(REJECTION_REASONS.PROHIBITED_FIELD);
    metrics.observeHttpRequest('/v1/telemetry/events', 202, 5);

    const serialized = JSON.stringify(metrics.snapshot());
    for (const forbidden of [
      'symptom',
      'answer',
      'urgency',
      'condition',
      'red_flag',
      'latitude',
      'longitude',
      'session',
      'user',
      'facility_id',
      'article_id',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
