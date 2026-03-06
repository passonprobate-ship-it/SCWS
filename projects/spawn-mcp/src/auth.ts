import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized" },
      id: null,
    });
    return;
  }

  const token = authHeader.slice(7);
  if (!safeCompare(token, AUTH_TOKEN)) {
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Forbidden" },
      id: null,
    });
    return;
  }

  next();
}
