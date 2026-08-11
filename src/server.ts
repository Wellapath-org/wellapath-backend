import { buildApp } from './app';
import { config } from './config/env';

const start = async (): Promise<void> => {
  const { server } = await buildApp();

  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
    server.log.info(`Server running on port ${config.port}`);
    server.log.info(
      {
        telemetry_enabled: config.telemetry.enabled,
        telemetry_sink: config.telemetry.sink,
      },
      'Telemetry intake configuration',
    );
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
