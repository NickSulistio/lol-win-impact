import { parseLimits, type Limit } from './riot/rateLimiter';

export interface Config {
  apiKey: string;
  platform: string;
  limits: Limit[];
  dbPath: string;
}

export function loadConfig(overrides: { platform?: string } = {}): Config {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env is optional; real env vars still apply.
  }
  const apiKey = process.env.RIOT_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('RIOT_API_KEY is not set. Copy .env.example to .env and add your key.');
  }
  return {
    apiKey,
    platform: (overrides.platform ?? process.env.RIOT_PLATFORM ?? 'na1').toLowerCase(),
    limits: parseLimits(process.env.RIOT_RATE_LIMITS ?? '20:1,100:120'),
    dbPath: process.env.DB_PATH ?? 'data/lol.db',
  };
}
