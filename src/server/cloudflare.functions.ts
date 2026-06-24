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
