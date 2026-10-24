import 'dotenv/config';

function positiveInt(value: string | undefined, fallback: number): number {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result <= 0 || result > 65535) {
    throw new Error('APP_PORT must be a positive integer <= 65535');
  }
  return result;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: positiveInt(process.env.APP_PORT, 3600),
  databaseUrl: process.env.DATABASE_URL,
  dbSsl: process.env.DB_SSL === 'true',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
};
