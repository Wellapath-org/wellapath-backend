/**
 * Sink selection. The only place a sink name maps to an implementation.
 *
 * Adding a provider later means adding a case here and a file next to it — nothing else in the
 * telemetry pipeline changes. An unrecognised name falls back to the no-op sink rather than
 * throwing at boot, so a misconfigured environment variable degrades telemetry instead of
 * taking the service down.
 */
import { LogSink, LogSinkLogger } from './log-sink';
import { NoopSink } from './noop-sink';
import { TelemetrySink } from './types';

export const SINK_NAMES: readonly string[] = ['log', 'none'];

export interface SinkFactoryOptions {
  name: string;
  logger: LogSinkLogger;
  /** Called when the requested sink name is not recognised. */
  onUnknown?: (name: string) => void;
}

export const createSink = ({ name, logger, onUnknown }: SinkFactoryOptions): TelemetrySink => {
  switch (name) {
    case 'log':
      return new LogSink(logger);
    case 'none':
      return new NoopSink();
    default:
      onUnknown?.(name);
      return new NoopSink();
  }
};
