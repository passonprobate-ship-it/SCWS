import { createHmac } from "crypto";
import { storage } from "./storage.js";
import { log } from "./logger.js";

// ── Config Types ──────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  chatId?: string;
  botUsername?: string;
}

export interface EmailConfig {
  apiKey: string;
  inboxId: string;
  recipientEmail: string;
  inboxAddress?: string;
}

export interface WebhookConfig {
  url: string;
  secret?: string;
}

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  recipientPhone: string;
}

// ── Config Helpers ────────────────────────────────────────────────

export function sanitizeChannelConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...config };
  if (type === "telegram" && safe.botToken) {
    const token = String(safe.botToken);
    safe.botToken = "***" + token.slice(-4);
  }
  if (type === "email" && safe.apiKey) {
    const key = String(safe.apiKey);
    safe.apiKey = "***" + key.slice(-4);
  }
  if (type === "webhook" && safe.secret) {
    const s = String(safe.secret);
    safe.secret = "***" + s.slice(-4);
  }
  if (type === "whatsapp" && safe.accessToken) {
    const t = String(safe.accessToken);
    safe.accessToken = "***" + t.slice(-4);
  }
  return safe;
}

export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/bot[A-Za-z0-9:_-]{20,}\//g, "bot****/")
    .replace(/api_key=[^&\s]+/g, "api_key=****");
}

// ── Telegram API ──────────────────────────────────────────────────

const TG_API = "https://api.telegram.org";

export async function validateTelegramBot(botToken: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json() as { ok: boolean; result?: { username: string }; description?: string };
    if (!data.ok) return { ok: false, error: data.description || "Invalid bot token" };
    return { ok: true, username: data.result?.username };
  } catch (err: unknown) {
    return { ok: false, error: sanitizeError(err) };
  }
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) return { ok: false, error: data.description || "Send failed" };
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: sanitizeError(err) };
  }
}

// ── Email API (AgentMail) ─────────────────────────────────────────

const AGENTMAIL_API = "https://api.agentmail.to/v0";

export async function validateEmailConfig(
  apiKey: string,
  inboxId: string,
): Promise<{ ok: boolean; address?: string; error?: string }> {
  try {
    const res = await fetch(`${AGENTMAIL_API}/inboxes/${inboxId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    const data = await res.json() as { address?: string };
    return { ok: true, address: data.address };
  } catch (err: unknown) {
    return { ok: false, error: sanitizeError(err) };
  }
}

export async function sendEmailNotification(
  config: EmailConfig,
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${AGENTMAIL_API}/inboxes/${config.inboxId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: [config.recipientEmail],
        subject,
        text: body,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return { ok: false, error: `HTTP ${res.status}: ${err}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: sanitizeError(err) };
  }
}

// ── Webhook API ──────────────────────────────────────────────────

export async function sendWebhookNotification(
  config: WebhookConfig,
  event: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload = JSON.stringify({
      event,
      message,
      timestamp: new Date().toISOString(),
      source: "spawn-daemon",
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.secret) {
      const sig = createHmac("sha256", config.secret).update(payload).digest("hex");
      headers["X-Hub-Signature-256"] = `sha256=${sig}`;
    }
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err: unknown) {
    return { ok: false, error: sanitizeError(err) };
  }
}

// ── WhatsApp API ─────────────────────────────────────────────────

const WHATSAPP_API = "https://graph.facebook.com/v21.0";

export async function validateWhatsApp(
  accessToken: string,
  phoneNumberId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${WHATSAPP_API}/${phoneNumberId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok
      ? { ok: true }
      : { ok: false, error: (await res.json().catch(() => ({}))).error?.message || `HTTP ${res.status}` };
  } catch (err: unknown) {
    return { ok: false, error: sanitizeError(err) };
  }
}

export async function sendWhatsAppMessage(
  config: WhatsAppConfig,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${WHATSAPP_API}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: config.recipientPhone,
        type: "text",
        text: { body: text },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok
      ? { ok: true }
      : { ok: false, error: (await res.json().catch(() => ({}))).error?.message || `HTTP ${res.status}` };
  } catch (err: unknown) {
    return { ok: false, error: sanitizeError(err) };
  }
}

// ── Default Notification Rules ────────────────────────────────────

export function getDefaultNotificationRules(): Record<string, boolean> {
  return {
    build_failed: true,
    build_succeeded: false,
    project_started: false,
    project_stopped: false,
    project_crashed: true,
    claude_completed: true,
    claude_failed: true,
    system_health: true,
    email_received: true,
  };
}

// ── Notify Dispatcher ─────────────────────────────────────────────

export async function notify(event: string, message: string): Promise<void> {
  try {
    const rulesRaw = await storage.getConfig("notification-rules");
    const rules: Record<string, boolean> = rulesRaw
      ? JSON.parse(rulesRaw)
      : getDefaultNotificationRules();

    if (rules[event] === false) return;

    const allChannels = await storage.getChannels();
    const active = allChannels.filter(ch => ch.enabled === 1 && ch.verified === 1);
    if (!active.length) return;

    const results = await Promise.allSettled(
      active.map(async (ch) => {
        const config = JSON.parse(ch.config);
        let result: { ok: boolean; error?: string } | undefined;

        if (ch.type === "telegram") {
          const tgConfig = config as TelegramConfig;
          if (!tgConfig.chatId) return;
          const formatted = `<b>[SPAWN]</b> ${event.replace(/_/g, " ").toUpperCase()}\n\n${message}`;
          result = await sendTelegramMessage(tgConfig.botToken, tgConfig.chatId, formatted);
        } else if (ch.type === "email") {
          const emailConfig = config as EmailConfig;
          const subject = `[SPAWN] ${event.replace(/_/g, " ")}`;
          result = await sendEmailNotification(emailConfig, subject, message);
        } else if (ch.type === "webhook") {
          result = await sendWebhookNotification(config as WebhookConfig, event, message);
        } else if (ch.type === "whatsapp") {
          const waConfig = config as WhatsAppConfig;
          const formatted = `[SPAWN] ${event.replace(/_/g, " ").toUpperCase()}\n\n${message}`;
          result = await sendWhatsAppMessage(waConfig, formatted);
        } else {
          return;
        }

        await storage.logNotification({
          channelId: ch.id,
          event,
          message,
          status: result.ok ? "sent" : "failed",
          error: result.error || null,
        });
      }),
    );

    const failures = results.filter(r => r.status === "rejected");
    if (failures.length) {
      log(`Notification failures for "${event}": ${failures.length}/${results.length}`, "channels");
    }
  } catch (err: unknown) {
    log(`notify() error: ${sanitizeError(err)}`, "channels");
  }
}

// ── Test Channel ──────────────────────────────────────────────────

export async function testChannel(channelId: string): Promise<{ ok: boolean; error?: string }> {
  const channel = await storage.getChannel(channelId);
  if (!channel) return { ok: false, error: "Channel not found" };

  const config = JSON.parse(channel.config);
  let result: { ok: boolean; error?: string };

  if (channel.type === "telegram") {
    const tgConfig = config as TelegramConfig;
    if (!tgConfig.chatId) return { ok: false, error: "Channel not verified (no chat ID)" };
    result = await sendTelegramMessage(
      tgConfig.botToken,
      tgConfig.chatId,
      "<b>[SPAWN Test]</b>\nNotification channel is working!",
    );
  } else if (channel.type === "email") {
    result = await sendEmailNotification(
      config as EmailConfig,
      "[SPAWN Test] Notification channel is working!",
      "This is a test notification from your SPAWN daemon.",
    );
  } else if (channel.type === "webhook") {
    result = await sendWebhookNotification(config as WebhookConfig, "test", "Notification channel is working!");
  } else if (channel.type === "whatsapp") {
    result = await sendWhatsAppMessage(config as WhatsAppConfig, "[SPAWN Test] Notification channel is working!");
  } else {
    return { ok: false, error: `Unsupported channel type: ${channel.type}` };
  }

  await storage.updateChannel(channelId, {
    status: result.ok ? "connected" : "error",
    statusMessage: result.error || null,
    lastTestedAt: new Date(),
  });

  await storage.logNotification({
    channelId,
    event: "test",
    message: "Test notification",
    status: result.ok ? "sent" : "failed",
    error: result.error || null,
  });

  return result;
}
