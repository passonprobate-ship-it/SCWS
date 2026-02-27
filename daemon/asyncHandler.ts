import type { Request, Response, NextFunction } from "express";
import { log } from "./logger.js";

export function asyncHandler(label: string, fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err) => {
      log(`${label}: ${err}`, "error");
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${label.toLowerCase()}` });
    });
  };
}
