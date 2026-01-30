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
  OPENAI_API_KEY: string;
  OPENAI_REALTIME_MODEL: string;
  OPENAI_REALTIME_URL: string;
  OPENAI_SCOPE_GUARD_MODEL: string;
  CONTACT_TO_EMAIL: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASS: string;
  SMTP_FROM: string;
};

export function getEnv(): Env {
  loadEnv();
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const jwtSecret =
    process.env.JWT_SECRET ??
    (nodeEnv === "development" ? "dev-secret-change-me" : "");

  const dailyDomain = process.env.DAILY_DOMAIN ?? "";
  const dailyApiKey = process.env.DAILY_API_KEY ?? "";

  const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
  const openaiRealtimeModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";
  const openaiRealtimeUrl =
    process.env.OPENAI_REALTIME_URL ??
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(openaiRealtimeModel)}`;

  const openaiScopeGuardModel = process.env.OPENAI_SCOPE_GUARD_MODEL ?? "gpt-4o-mini";

  const contactToEmail = process.env.CONTACT_TO_EMAIL ?? "";
  const smtpHost = process.env.SMTP_HOST ?? "";
  const smtpPort = parseNumber(process.env.SMTP_PORT, 587);
  const smtpSecure = parseBool(process.env.SMTP_SECURE, false);
  const smtpUser = process.env.SMTP_USER ?? "";
  const smtpPass = process.env.SMTP_PASS ?? "";
  const smtpFrom = process.env.SMTP_FROM ?? "";

  return {
    PORT: parseNumber(process.env.PORT, 4000),
    NODE_ENV: nodeEnv,
    TRUST_PROXY: parseBool(process.env.TRUST_PROXY, false),
    CORS_ORIGINS: parseCsv(process.env.CORS_ORIGINS),
    JWT_SECRET: jwtSecret,
    DAILY_DOMAIN: dailyDomain,
    DAILY_API_KEY: dailyApiKey,
    OPENAI_API_KEY: openaiApiKey,
    OPENAI_REALTIME_MODEL: openaiRealtimeModel,
    OPENAI_REALTIME_URL: openaiRealtimeUrl,
    OPENAI_SCOPE_GUARD_MODEL: openaiScopeGuardModel,
    CONTACT_TO_EMAIL: contactToEmail,
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort,
    SMTP_SECURE: smtpSecure,
    SMTP_USER: smtpUser,
    SMTP_PASS: smtpPass,
    SMTP_FROM: smtpFrom
  };
}
