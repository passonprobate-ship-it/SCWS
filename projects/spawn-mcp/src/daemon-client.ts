const DAEMON_URL = process.env.DAEMON_URL || "http://localhost:4000";
const DAEMON_TOKEN = process.env.DAEMON_TOKEN || "";
const FETCH_TIMEOUT_MS = 10000;

interface DaemonResponse {
  ok: boolean;
  status: number;
  data: any;
}

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

export async function daemonGet(path: string): Promise<DaemonResponse> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    signal: withTimeout(),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function daemonPost(path: string, body?: any): Promise<DaemonResponse> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: withTimeout(),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function daemonPatch(path: string, body?: any): Promise<DaemonResponse> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${DAEMON_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: withTimeout(),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function daemonDelete(path: string): Promise<DaemonResponse> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    signal: withTimeout(),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
