export interface McDomain {
  domain: string;
  active: number;
  max_mailboxes: number;
  max_quota: number;
  quota: number;
}

export interface McMailbox {
  local_part: string;
  domain: string;
  name: string;
  quota: number;
  active: number;
}

export interface McDkimResponse {
  dkim_public: string;
}

export interface McApiResponse<T = unknown> {
  msg: string;
  type: string;
  log: string[];
  dns_entries?: string[];
}

export interface McDomainResponse {
  domain: string;
}

export interface McMailboxResponse {
  username: string;
}

async function mcRequest<T = unknown>(
  hostname: string,
  apiKey: string,
  endpoint: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://${hostname}/api/v1/${endpoint}`, {
    method,
    headers: {
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`Mailcow API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function verifyMcApiKey(hostname: string, apiKey: string): Promise<boolean> {
  try {
    const response = await mcRequest<McApiResponse>(hostname, apiKey, "get/domain/all");
    return response.msg === "get_domain_all";
  } catch {
    return false;
  }
}

export interface AddMcDomainOptions {
  active?: number;
  maxMailboxes?: number;
  maxQuota?: number;
  quota?: number;
}

export async function addMcDomain(
  hostname: string,
  apiKey: string,
  domain: string,
  options?: AddMcDomainOptions,
): Promise<McDomainResponse> {
  const payload: McDomain = {
    domain,
    active: options?.active ?? 1,
    max_mailboxes: options?.maxMailboxes ?? 10,
    max_quota: options?.maxQuota ?? 10240,
    quota: options?.quota ?? 10240,
  };

  return mcRequest<McDomainResponse>(hostname, apiKey, "add/domain", "POST", payload);
}

export async function deleteMcDomain(
  hostname: string,
  apiKey: string,
  domain: string,
): Promise<McApiResponse> {
  return mcRequest<McApiResponse>(hostname, apiKey, "delete/domain", "POST", { domain });
}

export async function listMcDomains(hostname: string, apiKey: string): Promise<string[]> {
  const response = await mcRequest<McApiResponse>(hostname, apiKey, "get/domain/all");
  if (response.dns_entries) {
    return response.dns_entries;
  }
  return [];
}

export async function addMcMailbox(
  hostname: string,
  apiKey: string,
  mailbox: {
    localPart: string;
    domain: string;
    name: string;
    password: string;
    quota?: number;
    active?: number;
  },
): Promise<McMailboxResponse> {
  const payload: McMailbox = {
    local_part: mailbox.localPart,
    domain: mailbox.domain,
    name: mailbox.name,
    quota: mailbox.quota ?? 3072,
    active: mailbox.active ?? 1,
  };

  return mcRequest<McMailboxResponse>(hostname, apiKey, "add/mailbox", "POST", {
    ...payload,
    password: mailbox.password,
  });
}

export async function deleteMcMailbox(
  hostname: string,
  apiKey: string,
  localPart: string,
  domain: string,
): Promise<McApiResponse> {
  return mcRequest<McApiResponse>(hostname, apiKey, "delete/mailbox", "POST", {
    items: [`${localPart}@${domain}`],
  });
}

export async function listMcMailboxes(
  hostname: string,
  apiKey: string,
  domain?: string,
): Promise<McMailboxResponse[]> {
  const response = await mcRequest<McApiResponse<McMailboxResponse[]>>(
    hostname,
    apiKey,
    "get/mailbox/all",
  );
  if (Array.isArray(response)) {
    return domain ? response.filter((m) => m.domain === domain) : response;
  }
  return [];
}

export async function getMcMailbox(
  hostname: string,
  apiKey: string,
  localPart: string,
  domain: string,
): Promise<McMailboxResponse | null> {
  const mailboxes = await listMcMailboxes(hostname, apiKey, domain);
  return mailboxes.find((m) => m.username === `${localPart}@${domain}`) ?? null;
}

export async function getMcDkim(
  hostname: string,
  apiKey: string,
  domain: string,
): Promise<string | null> {
  try {
    const response = await mcRequest<McDkimResponse>(hostname, apiKey, `get/dkim/${domain}`);
    return response.dkim_public ?? null;
  } catch {
    return null;
  }
}

export async function setMcDkim(
  hostname: string,
  apiKey: string,
  domain: string,
  dkimPrivate: string,
): Promise<McApiResponse> {
  return mcRequest<McApiResponse>(hostname, apiKey, "add/dkim", "POST", {
    domain,
    private_key: dkimPrivate,
  });
}

export async function getMcResources(
  hostname: string,
  apiKey: string,
): Promise<{
  maxMailboxes: number;
  maxQuota: number;
  usedMailboxes: number;
  usedQuota: number;
}> {
  const response = await mcRequest<Record<string, unknown>>(
    hostname,
    apiKey,
    "get/status/overview",
  );
  return {
    maxMailboxes: Number(response.max_mailboxes) ?? 0,
    maxQuota: Number(response.max_quota) ?? 0,
    usedMailboxes: Number(response.used_mailboxes) ?? 0,
    usedQuota: Number(response.used_quota) ?? 0,
  };
}
