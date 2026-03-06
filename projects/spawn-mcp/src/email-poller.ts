import { amGet } from "./agentmail-client.js";
import { query } from "./db.js";
import { daemonPost } from "./daemon-client.js";

const INBOX_ID = "robot_001@agentmail.to";
const BASE_POLL_MS = 300_000; // 5 minutes
const MAX_BACKOFF_MS = 3_600_000; // 1 hour max backoff

interface MessageSummary {
  message_id: string;
  from: string;
  subject: string;
  timestamp: string;
}

export interface CheckResult {
  newCount: number;
  messages: MessageSummary[];
  lastChecked: string;
  error?: string;
}

let intervalHandle: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;

export async function checkNewEmail(): Promise<CheckResult> {
  try {
    // Read last-checked timestamp from spawn_memories
    const row = await query(
      `SELECT value FROM spawn_memories WHERE key = $1`,
      ["agentmail-last-checked"]
    );
    const now = new Date().toISOString();
    let lastChecked: string;
    if (row.rows.length > 0) {
      lastChecked = row.rows[0].value;
    } else {
      // Default to 24 hours ago
      lastChecked = new Date(Date.now() - 86_400_000).toISOString();
    }

    // Fetch messages since last check
    const res = await amGet(
      `/inboxes/${encodeURIComponent(INBOX_ID)}/messages?after=${encodeURIComponent(lastChecked)}&ascending=true&limit=20`
    );

    if (!res.ok) {
      consecutiveFailures++;
      return { newCount: 0, messages: [], lastChecked, error: `AgentMail API ${res.status}` };
    }

    const items: any[] = res.data?.items || res.data?.messages || [];
    if (items.length === 0) {
      return { newCount: 0, messages: [], lastChecked };
    }

    // Extract summaries
    const messages: MessageSummary[] = items.map((m: any) => ({
      message_id: m.id || m.message_id,
      from: m.from?.address || m.from_address || m.from || "unknown",
      subject: m.subject || "(no subject)",
      timestamp: m.created_at || m.timestamp || m.date || now,
    }));

    // Find the newest message timestamp for next poll boundary
    const newestTimestamp = messages[messages.length - 1].timestamp || now;

    // Upsert last-checked timestamp
    await query(
      `INSERT INTO spawn_memories (key, value, tags, created_at, updated_at)
       VALUES ($1, $2, '[]', NOW(), NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      ["agentmail-last-checked", newestTimestamp]
    );

    // Notify daemon
    const summaryText = messages
      .map((m) => `  - From: ${m.from} | Subject: ${m.subject}`)
      .join("\n");
    const detail = `${messages.length} new email(s) in ${INBOX_ID}:\n${summaryText}`;

    await daemonPost("/api/activity", {
      action: "email_received",
      details: detail,
    }).catch((e) => console.error("[email-poller] activity log error:", e));

    await daemonPost("/api/notify", {
      event: "email_received",
      message: detail,
    }).catch((e) => console.error("[email-poller] notify error:", e));

    consecutiveFailures = 0; // reset on success
    console.log(`[email-poller] ${messages.length} new email(s) found`);
    return { newCount: messages.length, messages, lastChecked: newestTimestamp };
  } catch (err: any) {
    consecutiveFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    if (consecutiveFailures <= 3) {
      console.error("[email-poller] checkNewEmail error:", msg);
    } else if (consecutiveFailures === 4) {
      console.error(`[email-poller] checkNewEmail error (suppressing further): ${msg}`);
    }
    // silently back off after 4 consecutive failures
    return { newCount: 0, messages: [], lastChecked: new Date().toISOString(), error: msg };
  }
}

function getNextDelay(): number {
  if (consecutiveFailures === 0) return BASE_POLL_MS;
  // Exponential backoff: 5m → 10m → 20m → 40m → capped at 60m
  return Math.min(BASE_POLL_MS * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS);
}

function scheduleNext(): void {
  const delay = getNextDelay();
  intervalHandle = setTimeout(async () => {
    await checkNewEmail().catch(() => {});
    scheduleNext();
  }, delay);
}

export function startPoller(): void {
  if (intervalHandle) return;
  console.log("[email-poller] Starting (base interval: 5 min, backoff on failure)");
  // Initial check after 30 seconds
  intervalHandle = setTimeout(async () => {
    await checkNewEmail().catch(() => {});
    scheduleNext();
  }, 30_000);
}

export function stopPoller(): void {
  if (intervalHandle) {
    clearTimeout(intervalHandle);
    intervalHandle = null;
    console.log("[email-poller] Stopped");
  }
}
