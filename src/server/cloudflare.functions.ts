export interface CfTokenVerifyResponse {
  success: boolean;
  result: {
    id: string;
    status: string;
  } | null;
  errors: { message: string }[];
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
}

export interface CfZonesResponse {
  success: boolean;
  result: CfZone[];
  errors: { message: string }[];
  result_info: {
    page: number;
    per_page: number;
    total_count: number;
  };
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  created_on: string;
  modified_on: string;
}

export interface CfDnsRecordsResponse {
  success: boolean;
  result: CfDnsRecord[];
  errors: { message: string }[];
  result_info: {
    page: number;
    per_page: number;
    total_count: number;
  };
}

export interface CfCreateDnsRecordResponse {
  success: boolean;
  result: CfDnsRecord;
  errors: { message: string }[];
}

export interface CfDeleteDnsRecordResponse {
  success: boolean;
  result: { id: string };
  errors: { message: string }[];
}

import { retryTransient } from "@/lib/retry";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export async function verifyCfToken(token: string): Promise<CfTokenVerifyResponse> {
  const res = await fetch(`${CF_API_BASE}/user/tokens/verify`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

export async function listCfZones(
  token: string,
  accountId?: string,
  page: number = 1,
  perPage: number = 50,
): Promise<CfZonesResponse> {
  const url = accountId
    ? `${CF_API_BASE}/accounts/${accountId}/zones?page=${page}&per_page=${perPage}`
    : `${CF_API_BASE}/zones?page=${page}&per_page=${perPage}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

export async function getCfZone(
  token: string,
  zoneId: string,
): Promise<{
  success: boolean;
  result: CfZone | null;
  errors: { message: string }[];
}> {
  const res = await fetch(`${CF_API_BASE}/zones/${zoneId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

export async function listCfDnsRecords(
  token: string,
  zoneId: string,
  page: number = 1,
  perPage: number = 100,
): Promise<CfDnsRecordsResponse> {
  const res = await fetch(
    `${CF_API_BASE}/zones/${zoneId}/dns_records?page=${page}&per_page=${perPage}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );
  return res.json();
}

// Fetch every DNS record in a zone (paginated). Used to make the DNS push idempotent —
// records that already exist are adopted instead of re-created.
export async function fetchAllCfDnsRecords(
  token: string,
  zoneId: string,
): Promise<CfDnsRecord[]> {
  const all: CfDnsRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const resp = await listCfDnsRecords(token, zoneId, page, 100);
    if (!resp.success || !resp.result || resp.result.length === 0) break;
    all.push(...resp.result);
    if (resp.result.length < 100) break;
  }
  return all;
}

export async function createCfDnsRecord(
  token: string,
  zoneId: string,
  record: {
    type: string;
    name: string;
    content: string;
    ttl?: number;
    proxied?: boolean;
  },
): Promise<CfCreateDnsRecordResponse> {
  const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(record),
  });
  return res.json();
}

// The parsed outcome of a resilient record create, carrying the HTTP status through so callers
// can distinguish a deterministic error (e.g. "already exists", 400) from a transient one.
export interface CfCreateOutcome {
  success: boolean;
  result?: { id: string };
  errors?: { message: string }[];
  status: number;
}

// Create a DNS record, retrying TRANSIENT failures — rate limiting (429, honouring Retry-After),
// 5xx, and network/timeout errors — with backoff. This is what makes bulk DNS pushes reliable:
// without it, a burst of parallel record creates that trips Cloudflare's rate limit leaves a
// random subset failed, forcing repeated manual re-runs. Deterministic 4xx (e.g. "an identical
// record already exists") is returned immediately for the caller's idempotency handling.
export function createCfDnsRecordResilient(
  token: string,
  zoneId: string,
  body: Record<string, unknown>,
  opts?: { attempts?: number },
): Promise<CfCreateOutcome> {
  return retryTransient<CfCreateOutcome>(
    async () => {
      try {
        const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json: any = await res.json().catch(() => ({}));
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        return { ...json, status: res.status, retryAfterMs: retryAfter * 1000 } as any;
      } catch (e) {
        // Network/timeout — status 0 marks it transient so retryTransient retries.
        return { success: false, errors: [{ message: String(e) }], status: 0 } as CfCreateOutcome;
      }
    },
    // Retry while the call did not succeed AND the status is transient (0/429/5xx).
    (r) => !r.success && (r.status === 0 || r.status === 429 || r.status >= 500),
    {
      attempts: opts?.attempts ?? 4,
      base: 700,
      extraDelayMs: (r) => (r as any)?.retryAfterMs ?? 0,
    },
  );
}

export async function updateCfDnsRecord(
  token: string,
  zoneId: string,
  recordId: string,
  record: {
    type: string;
    name: string;
    content: string;
    ttl?: number;
    proxied?: boolean;
  },
): Promise<CfCreateDnsRecordResponse> {
  const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(record),
  });
  return res.json();
}

export async function deleteCfDnsRecord(
  token: string,
  zoneId: string,
  recordId: string,
): Promise<CfDeleteDnsRecordResponse> {
  const res = await fetch(`${CF_API_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

export async function getCfZoneIdByName(token: string, domainName: string): Promise<string | null> {
  const response = await listCfZones(token, undefined, 1, 100);
  if (!response.success) return null;

  const zone = response.result.find(
    (z) => z.name === domainName || z.name.endsWith(`.${domainName}`),
  );
  return zone?.id ?? null;
}
