/**
 * Valid payload fixtures.
 *
 * Written out longhand rather than generated from the contract: a fixture derived from the same
 * declarations the validator reads would pass even if both were wrong together.
 */
import { TELEMETRY_CONTRACT_VERSION } from '../../src/telemetry/contract';

export const nowIso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

let counter = 0;
/** Unique, contract-valid event ID. */
export const eventId = (prefix = 'evt'): string => {
  counter += 1;
  return `${prefix}_${String(counter).padStart(6, '0')}_${'a'.repeat(8)}`;
};

export const SESSION_ID = 'sess_0123456789abcdef';

export const validAppContext = (): Record<string, unknown> => ({
  platform: 'android',
  app_version: '1.4.2',
  app_build: '204',
  os_version: '14',
});

/** One valid instance of every allowlisted event, keyed by event name. */
export const VALID_EVENTS: Record<string, () => Record<string, unknown>> = {
  app_open: () => ({
    event_name: 'app_open',
    event_id: eventId(),
    client_ts: nowIso(),
    launch_type: 'cold',
    is_first_launch: false,
  }),
  assessment_start: () => ({
    event_name: 'assessment_start',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
    flow_version: '1.0',
    entry_point: 'home',
  }),
  assessment_step_view: () => ({
    event_name: 'assessment_step_view',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
    step_index: 3,
    step_count: 8,
  }),
  assessment_complete: () => ({
    event_name: 'assessment_complete',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
    completion_status: 'completed',
    duration_ms: 45000,
    step_count: 8,
  }),
  result_view: () => ({
    event_name: 'result_view',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
    presentation_contract_version: '1.0',
  }),
  facility_search: () => ({
    event_name: 'facility_search',
    event_id: eventId(),
    client_ts: nowIso(),
    search_mode: 'nearby',
    admin_area_code: 'NG-LA',
    result_count: 12,
  }),
  facility_view: () => ({
    event_name: 'facility_view',
    event_id: eventId(),
    client_ts: nowIso(),
    facility_id: 'fac_lagos_00123',
    source: 'search_results',
  }),
  facility_call: () => ({
    event_name: 'facility_call',
    event_id: eventId(),
    client_ts: nowIso(),
    facility_id: 'fac_lagos_00123',
    source: 'facility_detail',
  }),
  directions_open: () => ({
    event_name: 'directions_open',
    event_id: eventId(),
    client_ts: nowIso(),
    facility_id: 'fac_lagos_00123',
    source: 'facility_detail',
  }),
  emergency_action: () => ({
    event_name: 'emergency_action',
    event_id: eventId(),
    client_ts: nowIso(),
    action_type: 'call_emergency_number',
  }),
  library_article_view: () => ({
    event_name: 'library_article_view',
    event_id: eventId(),
    client_ts: nowIso(),
    article_id: 'art_malaria_overview',
    content_version: '2.4',
  }),
  feedback_submit: () => ({
    event_name: 'feedback_submit',
    event_id: eventId(),
    client_ts: nowIso(),
    rating: 4,
    category: 'usability',
  }),
};

/** Only the minimum required properties for each event — exercises optionality. */
export const MINIMAL_EVENTS: Record<string, () => Record<string, unknown>> = {
  app_open: () => ({
    event_name: 'app_open',
    event_id: eventId(),
    client_ts: nowIso(),
    launch_type: 'warm',
  }),
  assessment_start: () => ({
    event_name: 'assessment_start',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
  }),
  assessment_step_view: () => ({
    event_name: 'assessment_step_view',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
    step_index: 0,
  }),
  assessment_complete: () => ({
    event_name: 'assessment_complete',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
    completion_status: 'abandoned',
  }),
  result_view: () => ({
    event_name: 'result_view',
    event_id: eventId(),
    client_ts: nowIso(),
    assessment_session_id: SESSION_ID,
  }),
  facility_search: () => ({
    event_name: 'facility_search',
    event_id: eventId(),
    client_ts: nowIso(),
    search_mode: 'name',
  }),
  facility_view: () => ({
    event_name: 'facility_view',
    event_id: eventId(),
    client_ts: nowIso(),
    facility_id: 'fac_1',
  }),
  facility_call: () => ({
    event_name: 'facility_call',
    event_id: eventId(),
    client_ts: nowIso(),
    facility_id: 'fac_1',
  }),
  directions_open: () => ({
    event_name: 'directions_open',
    event_id: eventId(),
    client_ts: nowIso(),
    facility_id: 'fac_1',
  }),
  emergency_action: () => ({
    event_name: 'emergency_action',
    event_id: eventId(),
    client_ts: nowIso(),
    action_type: 'view_emergency_guidance',
  }),
  library_article_view: () => ({
    event_name: 'library_article_view',
    event_id: eventId(),
    client_ts: nowIso(),
    article_id: 'art_1',
  }),
  feedback_submit: () => ({
    event_name: 'feedback_submit',
    event_id: eventId(),
    client_ts: nowIso(),
    rating: 1,
  }),
};

export const validEnvelope = (events: Record<string, unknown>[]): Record<string, unknown> => ({
  contract_version: TELEMETRY_CONTRACT_VERSION,
  sent_at: nowIso(),
  app: validAppContext(),
  events,
});

/** A one-event envelope for the named allowlisted event. */
export const envelopeFor = (eventName: string): Record<string, unknown> =>
  validEnvelope([VALID_EVENTS[eventName]()]);
