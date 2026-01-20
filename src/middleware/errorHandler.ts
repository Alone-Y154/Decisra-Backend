import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../utils/httpError";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const message = err instanceof Error ? err.message : "Internal Server Error";

  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: {
        message: err.message
      }
    });
  }

  if (message.startsWith("CORS:")) {
    return res.status(403).json({
      error: {
        message
      }
    });
  }

  return res.status(500).json({
    error: {
      message
    }
  });
}
