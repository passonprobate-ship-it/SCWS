const BASE_URL = "https://api.search.brave.com/res/v1";
const API_KEY = process.env.BRAVE_API_KEY || "";

export interface BraveResponse {
  ok: boolean;
  status: number;
  data: any;
}

export async function braveGet(path: string, params?: Record<string, any>): Promise<BraveResponse> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": API_KEY,
    },
  });

  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
