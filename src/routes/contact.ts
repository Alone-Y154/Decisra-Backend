import { Router } from "express";
import { HttpError } from "../utils/httpError";
import nodemailer from "nodemailer";
import { getEnv } from "../utils/env";

type ContactBody = {
  about?: string;
  email: string;
  message: string;
  role?: string;
  teamSize?: string;
  interestType?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validateEmail(email: string): boolean {
  // Basic email validation (intentionally not RFC-perfect)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function enforceMaxLen(field: string, value: string, max: number) {
  if (value.length > max) {
    throw new HttpError(400, `Validation: ${field} is too long (max ${max})`);
  }
}

function validateContactBody(body: unknown): ContactBody {
  if (!isPlainObject(body)) {
    throw new HttpError(400, "Validation: body must be an object");
  }

  const allowedKeys = new Set(["about", "email", "message", "role", "teamSize", "interestType"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new HttpError(400, `Validation: unknown field '${key}'`);
    }
  }

  const email = (coerceString(body.email) ?? "").trim();
  const message = (coerceString(body.message) ?? "").trim();
  const about = coerceString(body.about);
  const role = coerceString(body.role);
  const teamSize = coerceString(body.teamSize);
  const interestType = coerceString(body.interestType);

  if (!email) throw new HttpError(400, "Validation: email is required");
  if (!validateEmail(email)) throw new HttpError(400, "Validation: email is invalid");
  if (!message) throw new HttpError(400, "Validation: message is required");

  if (about !== undefined) enforceMaxLen("about", about, 2000);
  enforceMaxLen("message", message, 5000);
  if (role !== undefined) enforceMaxLen("role", role, 100);
  if (teamSize !== undefined) enforceMaxLen("teamSize", teamSize, 100);
  if (interestType !== undefined) enforceMaxLen("interestType", interestType, 100);

  return {
    about,
    email,
    message,
    role,
    teamSize,
    interestType
  };
}

export function createContactRouter() {
  const router = Router();

  // Contact form endpoint.
  // Sends an email via SMTP to CONTACT_TO_EMAIL.
  router.post("/api/contact", (req, res, next) => {
    (async () => {
      try {
      const payload = validateContactBody(req.body);

      const env = getEnv();
      const to = (env.CONTACT_TO_EMAIL || "").trim();
      if (!to) {
        throw new HttpError(501, "CONTACT_TO_EMAIL is not configured");
      }

      if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
        throw new HttpError(501, "SMTP is not configured (SMTP_HOST/SMTP_PORT/SMTP_FROM)");
      }

      if (!env.SMTP_USER || !env.SMTP_PASS) {
        throw new HttpError(501, "SMTP credentials are not configured (SMTP_USER/SMTP_PASS)");
      }

      const meta = {
        receivedAt: Date.now(),
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      };

      const transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS
        }
      });

      const subject = `Decisra Contact — ${payload.email}`;
      const text =
        `New contact form submission\n\n` +
        `From: ${payload.email}\n` +
        (payload.role ? `Role: ${payload.role}\n` : "") +
        (payload.teamSize ? `Team size: ${payload.teamSize}\n` : "") +
        (payload.interestType ? `Interested in: ${payload.interestType}\n` : "") +
        (payload.about ? `\nAbout:\n${payload.about}\n` : "") +
        `\nMessage:\n${payload.message}\n\n` +
        `Meta: ${JSON.stringify(meta)}`;

      await transporter.sendMail({
        from: env.SMTP_FROM,
        to,
        replyTo: payload.email,
        subject,
        text
      });

      // eslint-disable-next-line no-console
      console.log("[contact] sent", { to, from: env.SMTP_FROM, replyTo: payload.email, ...meta });

      return res.status(200).json({ ok: true });
      } catch (err) {
        return next(err);
      }
    })();
  });

  return router;
}
