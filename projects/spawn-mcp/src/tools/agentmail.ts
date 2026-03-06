import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { amGet, amPost } from "../agentmail-client.js";

function buildQuery(params: Record<string, any>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${k}=${encodeURIComponent(item)}`);
    } else {
      parts.push(`${k}=${encodeURIComponent(v)}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

export function registerAgentmailTools(server: McpServer): void {
  // --- List Inboxes ---
  server.registerTool("spawn_email_list_inboxes", {
    description: "List all AgentMail inboxes",
    inputSchema: {
      limit: z.number().optional().describe("Max results to return"),
      page_token: z.string().optional().describe("Pagination token"),
    },
  }, async ({ limit, page_token }) => {
    const qs = buildQuery({ limit, page_token });
    const res = await amGet(`/inboxes${qs}`);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- Create Inbox ---
  server.registerTool("spawn_email_create_inbox", {
    description: "Create a new AgentMail inbox. Returns the inbox with its email address.",
    inputSchema: {
      username: z.string().optional().describe("Local part of address (random if omitted)"),
      domain: z.string().optional().describe("Domain (defaults to agentmail.to)"),
      display_name: z.string().optional().describe("Display name for the inbox"),
    },
  }, async ({ username, domain, display_name }) => {
    const body: Record<string, any> = {};
    if (username) body.username = username;
    if (domain) body.domain = domain;
    if (display_name) body.display_name = display_name;
    const res = await amPost("/inboxes", body);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- Send Email ---
  server.registerTool("spawn_email_send", {
    description: "Send an email from an AgentMail inbox",
    inputSchema: {
      inbox_id: z.string().describe("Inbox ID (the email address, e.g. spawn@agentmail.to)"),
      to: z.array(z.string()).describe("Recipient email addresses"),
      subject: z.string().optional().describe("Email subject"),
      text: z.string().optional().describe("Plain text body"),
      html: z.string().optional().describe("HTML body"),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
    },
  }, async ({ inbox_id, to, subject, text, html, cc, bcc }) => {
    const body: Record<string, any> = { to };
    if (subject) body.subject = subject;
    if (text) body.text = text;
    if (html) body.html = html;
    if (cc) body.cc = cc;
    if (bcc) body.bcc = bcc;
    const res = await amPost(`/inboxes/${enc(inbox_id)}/messages/send`, body);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- List Messages ---
  server.registerTool("spawn_email_list_messages", {
    description: "List messages in an AgentMail inbox",
    inputSchema: {
      inbox_id: z.string().describe("Inbox ID (the email address)"),
      limit: z.number().optional().describe("Max results"),
      page_token: z.string().optional().describe("Pagination token"),
      before: z.string().optional().describe("Filter: messages before this ISO timestamp"),
      after: z.string().optional().describe("Filter: messages after this ISO timestamp"),
      ascending: z.boolean().optional().describe("Sort ascending by time"),
    },
  }, async ({ inbox_id, limit, page_token, before, after, ascending }) => {
    const qs = buildQuery({ limit, page_token, before, after, ascending });
    const res = await amGet(`/inboxes/${enc(inbox_id)}/messages${qs}`);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- Get Message ---
  server.registerTool("spawn_email_get_message", {
    description: "Read a full email message by ID",
    inputSchema: {
      inbox_id: z.string().describe("Inbox ID (the email address)"),
      message_id: z.string().describe("Message ID"),
    },
  }, async ({ inbox_id, message_id }) => {
    const res = await amGet(`/inboxes/${enc(inbox_id)}/messages/${enc(message_id)}`);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- Reply to Message ---
  server.registerTool("spawn_email_reply", {
    description: "Reply to an email message (auto-threads)",
    inputSchema: {
      inbox_id: z.string().describe("Inbox ID (the email address)"),
      message_id: z.string().describe("Message ID to reply to"),
      text: z.string().optional().describe("Plain text reply body"),
      html: z.string().optional().describe("HTML reply body"),
      to: z.array(z.string()).optional().describe("Override recipients"),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
      reply_all: z.boolean().optional().describe("Reply to all recipients"),
    },
  }, async ({ inbox_id, message_id, text, html, to, cc, bcc, reply_all }) => {
    const body: Record<string, any> = {};
    if (text) body.text = text;
    if (html) body.html = html;
    if (to) body.to = to;
    if (cc) body.cc = cc;
    if (bcc) body.bcc = bcc;
    if (reply_all !== undefined) body.reply_all = reply_all;
    const res = await amPost(`/inboxes/${enc(inbox_id)}/messages/${enc(message_id)}/reply`, body);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- List Threads ---
  server.registerTool("spawn_email_list_threads", {
    description: "List conversation threads in an AgentMail inbox",
    inputSchema: {
      inbox_id: z.string().describe("Inbox ID (the email address)"),
      limit: z.number().optional().describe("Max results"),
      page_token: z.string().optional().describe("Pagination token"),
      before: z.string().optional().describe("Filter: threads before this ISO timestamp"),
      after: z.string().optional().describe("Filter: threads after this ISO timestamp"),
      ascending: z.boolean().optional().describe("Sort ascending by time"),
    },
  }, async ({ inbox_id, limit, page_token, before, after, ascending }) => {
    const qs = buildQuery({ limit, page_token, before, after, ascending });
    const res = await amGet(`/inboxes/${enc(inbox_id)}/threads${qs}`);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- Get Thread ---
  server.registerTool("spawn_email_get_thread", {
    description: "Get a full conversation thread with all messages",
    inputSchema: {
      inbox_id: z.string().describe("Inbox ID (the email address)"),
      thread_id: z.string().describe("Thread ID"),
    },
  }, async ({ inbox_id, thread_id }) => {
    const res = await amGet(`/inboxes/${enc(inbox_id)}/threads/${enc(thread_id)}`);
    if (!res.ok) return { content: [{ type: "text", text: `Error ${res.status}: ${JSON.stringify(res.data)}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
  });

  // --- Check New Email ---
  server.registerTool("spawn_email_check_new", {
    description: "Check for new emails since last poll. Returns count and summaries of any new messages. Triggers notifications if new mail found.",
    inputSchema: {},
  }, async () => {
    const { checkNewEmail } = await import("../email-poller.js");
    const result = await checkNewEmail();
    if (result.error) {
      return { content: [{ type: "text", text: `Error checking email: ${result.error}` }], isError: true };
    }
    if (result.newCount === 0) {
      return { content: [{ type: "text", text: `No new emails since ${result.lastChecked}` }] };
    }
    const lines = result.messages.map(
      (m) => `- From: ${m.from} | Subject: ${m.subject} | ${m.timestamp}`
    );
    return {
      content: [{ type: "text", text: `${result.newCount} new email(s):\n${lines.join("\n")}` }],
    };
  });
}
