import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  if (err.message.includes("terminating connection") || err.message.includes("Connection terminated")) {
    console.error("[db] Pool connection reset (PG restart) — pool will auto-reconnect");
  } else {
    console.error("[db] Pool error (handled):", err.message);
  }
});

export const db = drizzle(pool, { schema });
