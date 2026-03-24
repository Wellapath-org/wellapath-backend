import dotenv from 'dotenv';
dotenv.config();

interface AppConfig {
  nodeEnv: string;
  port: number;
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  artifactBaseUrl: string;
  appVersion: string;
  awsRegion: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config: AppConfig = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  db: {
    host: requireEnv('DB_HOST'),
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    name: requireEnv('DB_NAME'),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
  },
  artifactBaseUrl: requireEnv('ARTIFACT_BASE_URL'),
  appVersion: process.env.APP_VERSION ?? '0.1.0',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
};
