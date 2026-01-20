import type { Request, Response, NextFunction } from "express";

export function notFoundHandler(req: Request, res: Response, _next: NextFunction) {
  res.status(404).json({
    error: {
      message: "Not Found",
      path: req.originalUrl
    }
  });
}
