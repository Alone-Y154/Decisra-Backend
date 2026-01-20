import dotenv from "dotenv";

let loaded = false;

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1" || value.toLowerCase() === "yes";
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function loadEnv() {
  if (loaded) return;
  dotenv.config();
  loaded = true;
}

export type Env = {
  PORT: number;
  NODE_ENV: string;
  TRUST_PROXY: boolean;
  CORS_ORIGINS: string[];
  JWT_SECRET: string;
  DAILY_DOMAIN: string;
  DAILY_API_KEY: string;
};

export function getEnv(): Env {
  loadEnv();
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const jwtSecret =
    process.env.JWT_SECRET ??
    (nodeEnv === "development" ? "dev-secret-change-me" : "");

  const dailyDomain = process.env.DAILY_DOMAIN ?? "";
  const dailyApiKey = process.env.DAILY_API_KEY ?? "";

  return {
    PORT: parseNumber(process.env.PORT, 4000),
    NODE_ENV: nodeEnv,
    TRUST_PROXY: parseBool(process.env.TRUST_PROXY, false),
    CORS_ORIGINS: parseCsv(process.env.CORS_ORIGINS),
    JWT_SECRET: jwtSecret,
    DAILY_DOMAIN: dailyDomain,
    DAILY_API_KEY: dailyApiKey
  };
}
