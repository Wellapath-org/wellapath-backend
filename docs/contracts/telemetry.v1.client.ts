/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Regenerate with `npm run telemetry:contract` in the wellapath-backend repository.
 * Telemetry contract version 1.0.
 *
 * These types describe exactly what the server accepts. Anything not declared here is
 * rejected at the boundary.
 */

export const TELEMETRY_CONTRACT_VERSION = '1.0';
export const TELEMETRY_ENDPOINT_PATH = '/v1/telemetry/events';
export const TELEMETRY_MAX_EVENTS_PER_BATCH = 20;
export const TELEMETRY_MAX_BODY_BYTES = 32768;

export type TelemetryEventName =
  | 'app_open'
  | 'assessment_start'
  | 'assessment_step_view'
  | 'assessment_complete'
  | 'result_view'
  | 'facility_search'
  | 'facility_view'
  | 'facility_call'
  | 'directions_open'
  | 'emergency_action'
  | 'library_article_view'
  | 'feedback_submit';

/** Coarse app/runtime context. */
export interface TelemetryAppContext {
  /** Mobile platform. (privacy: operational) */
  platform: 'ios' | 'android';
  /** Application version as released. (privacy: operational) */
  app_version: string;
  /** Application build number. (privacy: operational) */
  app_build: string;
  /** OS version, major[.minor] only. Full build strings are rejected. (privacy: operational) */
  os_version?: string;
}

/** Lifecycle only. No user, assessment or content reference. */
export interface AppOpenEvent {
  /** The application was brought to the foreground. (privacy: operational) */
  event_name: 'app_open';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Whether the process was started fresh or resumed. (privacy: operational) */
  launch_type: 'cold' | 'warm';
  /** True only on the first launch after installation. (privacy: operational) */
  is_first_launch?: boolean;
}

/** Carries an opaque per-assessment ID and non-clinical flow metadata. No symptom, answer or condition data. */
export interface AssessmentStartEvent {
  /** The user began an assessment. (privacy: operational) */
  event_name: 'assessment_start';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Opaque, ephemeral ID for this assessment. Generated per assessment, never reused, never derived from device or account identity. (privacy: ephemeral-pseudonymous) */
  assessment_session_id: string;
  /** Version of the assessment flow presented on-device. (privacy: operational) */
  flow_version?: string;
  /** Which screen the assessment was launched from. (privacy: operational) */
  entry_point?: 'home' | 'library' | 'facility_locator' | 'deep_link';
}

/** Ordinal position only. Question IDs are deliberately NOT accepted in v1.0: in an adaptive flow the sequence of question IDs within a session is answer-derived, which would let the backend partially reconstruct an assessment path. Ordinal position supports the drop-off funnel without that risk. */
export interface AssessmentStepViewEvent {
  /** An assessment step was displayed. (privacy: operational) */
  event_name: 'assessment_step_view';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Opaque, ephemeral ID for the assessment this step belongs to. (privacy: ephemeral-pseudonymous) */
  assessment_session_id: string;
  /** Zero-based ordinal position of the step within the flow. (privacy: operational) */
  step_index: number;
  /** Total steps in the flow at the time of viewing, if known. (privacy: operational) */
  step_count?: number;
}

/** Completion shape and effort measures only. `urgency_category` is NOT accepted — it is a clinical output and has no approval on record in this repository. */
export interface AssessmentCompleteEvent {
  /** An assessment reached a terminal state. (privacy: operational) */
  event_name: 'assessment_complete';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Opaque, ephemeral ID for the assessment. (privacy: ephemeral-pseudonymous) */
  assessment_session_id: string;
  /** How the assessment ended. (privacy: operational) */
  completion_status: 'completed' | 'abandoned' | 'interrupted';
  /** Wall-clock duration of the assessment in milliseconds. (privacy: operational) */
  duration_ms?: number;
  /** Number of steps the user actually reached. (privacy: operational) */
  step_count?: number;
}

/** Presentation-layer version only. No condition, differential, score, explanation, urgency or narrative is accepted. */
export interface ResultViewEvent {
  /** The result screen was displayed. (privacy: operational) */
  event_name: 'result_view';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Opaque, ephemeral ID for the assessment whose result was shown. (privacy: ephemeral-pseudonymous) */
  assessment_session_id: string;
  /** Version of the on-device result presentation contract. (privacy: operational) */
  presentation_contract_version?: string;
}

/** Search mode, outcome volume, and state-level administrative area only. No coordinates, no address text, no query text, no location history. */
export interface FacilitySearchEvent {
  /** The user ran a facility search. (privacy: operational) */
  event_name: 'facility_search';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** How the search was initiated. (privacy: operational) */
  search_mode: 'nearby' | 'manual_area' | 'name';
  /** ISO 3166-2:NG state-level code. State level is the finest geography accepted. Omit if the client cannot map its area to a code with confidence. (privacy: coarse-geography) */
  admin_area_code?: 'NG-AB' | 'NG-AD' | 'NG-AK' | 'NG-AN' | 'NG-BA' | 'NG-BE' | 'NG-BO' | 'NG-BY' | 'NG-CR' | 'NG-DE' | 'NG-EB' | 'NG-ED' | 'NG-EK' | 'NG-EN' | 'NG-FC' | 'NG-GO' | 'NG-IM' | 'NG-JI' | 'NG-KD' | 'NG-KE' | 'NG-KN' | 'NG-KO' | 'NG-KT' | 'NG-KW' | 'NG-LA' | 'NG-NA' | 'NG-NI' | 'NG-OG' | 'NG-ON' | 'NG-OS' | 'NG-OY' | 'NG-PL' | 'NG-RI' | 'NG-SO' | 'NG-TA' | 'NG-YO' | 'NG-ZA';
  /** Number of facilities returned. Zero-result searches are a coverage signal. (privacy: operational) */
  result_count?: number;
}

/** Facility ID and navigation origin only. Not correlated to any assessment session. */
export interface FacilityViewEvent {
  /** A facility detail screen was opened. (privacy: operational) */
  event_name: 'facility_view';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Identifier from the facilities artifact. (privacy: content-reference) */
  facility_id: string;
  /** Which surface the facility was opened from. (privacy: operational) */
  source?: 'search_results' | 'map' | 'saved' | 'emergency_screen';
}

/** Facility ID and navigation origin only. No phone number is accepted — the number is already published in the facilities artifact and echoing it back adds only risk. */
export interface FacilityCallEvent {
  /** The user initiated a call to a facility. (privacy: operational) */
  event_name: 'facility_call';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Identifier from the facilities artifact. (privacy: content-reference) */
  facility_id: string;
  /** Which surface the call was initiated from. (privacy: operational) */
  source?: 'search_results' | 'facility_detail' | 'emergency_screen';
}

/** Facility ID and handoff target only. No origin coordinates, no route data. */
export interface DirectionsOpenEvent {
  /** The user opened directions to a facility. (privacy: operational) */
  event_name: 'directions_open';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Identifier from the facilities artifact. (privacy: content-reference) */
  facility_id: string;
  /** Which surface directions were opened from. (privacy: operational) */
  source?: 'search_results' | 'facility_detail' | 'emergency_screen';
}

/** Allowlisted action type only. The triggering symptom, answer, red flag, rule ID and narrative are all rejected. No assessment session ID is accepted on this event — correlating an emergency action to an assessment would imply a red-flag match. */
export interface EmergencyActionEvent {
  /** The user took an action on an emergency surface. (privacy: operational) */
  event_name: 'emergency_action';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Which emergency affordance the user used. (privacy: operational) */
  action_type: 'call_emergency_number' | 'view_emergency_guidance' | 'dismiss_emergency_banner' | 'open_nearest_facility';
}

/** Published-content reference and content version only. Not correlated to any assessment session, so an article view cannot be joined to a clinical journey. */
export interface LibraryArticleViewEvent {
  /** A library article was opened. (privacy: operational) */
  event_name: 'library_article_view';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Identifier of the published article. (privacy: content-reference) */
  article_id: string;
  /** Version of the content bundle the article was served from. (privacy: operational) */
  content_version?: string;
}

/** Rating and category only. Free text is excluded from this contract entirely and must not be routed here — see docs/TELEMETRY_CONTRACT.md. */
export interface FeedbackSubmitEvent {
  /** The user submitted structured feedback. (privacy: operational) */
  event_name: 'feedback_submit';
  /** Client-generated unique ID for this event. Used for de-duplication only. (privacy: ephemeral-pseudonymous) */
  event_id: string;
  /** Client clock reading when the event occurred. ISO-8601 UTC. (privacy: operational) */
  client_ts: string;
  /** Star rating, 1 to 5. (privacy: structured-feedback) */
  rating: number;
  /** Bounded feedback category. (privacy: structured-feedback) */
  category?: 'usability' | 'performance' | 'content' | 'other';
}

export type TelemetryEvent =
  | AppOpenEvent
  | AssessmentStartEvent
  | AssessmentStepViewEvent
  | AssessmentCompleteEvent
  | ResultViewEvent
  | FacilitySearchEvent
  | FacilityViewEvent
  | FacilityCallEvent
  | DirectionsOpenEvent
  | EmergencyActionEvent
  | LibraryArticleViewEvent
  | FeedbackSubmitEvent;

/** Request envelope. */
export interface TelemetryEnvelope {
  contract_version: '1.0';
  /** ISO-8601 UTC, e.g. 2026-08-11T09:01:14.639Z */
  sent_at: string;
  app: TelemetryAppContext;
  events: TelemetryEvent[];
}

export type TelemetryEventStatus =
  | 'accepted'
  | 'rejected'
  | 'duplicate';

export type TelemetryRejectionReason =
  | 'malformed_json'
  | 'payload_too_large'
  | 'unsupported_content_type'
  | 'invalid_envelope'
  | 'unsupported_contract_version'
  | 'empty_batch'
  | 'batch_too_large'
  | 'telemetry_disabled'
  | 'rate_limited'
  | 'unknown_event'
  | 'unknown_property'
  | 'missing_required_property'
  | 'invalid_type'
  | 'invalid_enum_value'
  | 'invalid_format'
  | 'value_too_long'
  | 'value_out_of_range'
  | 'timestamp_out_of_range'
  | 'nested_value_not_allowed'
  | 'prohibited_field'
  | 'prohibited_container'
  | 'prohibited_value_shape'
  | 'unsafe_key'
  | 'payload_too_complex';

/** Per-event outcome returned in the 202 response. */
export interface TelemetryEventResult {
  index: number;
  status: TelemetryEventStatus;
  reason?: TelemetryRejectionReason;
  /** Allowlisted field name only. Client-supplied keys are never echoed. */
  field?: string;
}

/** 202 response body. */
export interface TelemetryAcceptedResponse {
  contract_version: string;
  received: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  results: TelemetryEventResult[];
}

/** Error response body, shared with the rest of the service. */
export interface TelemetryErrorResponse {
  error: {
    statusCode: number;
    message: string;
    reason_code?: TelemetryRejectionReason;
  };
}
