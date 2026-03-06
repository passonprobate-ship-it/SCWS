const BASE_URL = "https://api.agentmail.to/v0";
const API_KEY = process.env.AGENTMAIL_API_KEY || "";

interface AmResponse {
  ok: boolean;
  status: number;
  data: any;
}

export async function amGet(path: string): Promise<AmResponse> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function amPost(path: string, body?: any): Promise<AmResponse> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
