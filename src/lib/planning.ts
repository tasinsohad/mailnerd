/**
 * Pure planning utilities. No DB, no React.
 *
 * Algorithm v4 — improvements for truly random, natural-looking output:
 *  1. Weighted prefix selection (common prefixes like mail/web more likely)
 *  2. Fisher-Yates shuffle for true randomness
 *  3. Weighted format selection (first.last most common)
 *  4. Exponential decay + noise for subdomain distribution
 *  5. Truly random name picking (not sequential)
 *  6. Random collision resolution with varied strategies
 */

export type LocalFormat = "first" | "first.last" | "firstlast" | "f.last" | "first_last" | "firstl";

const FORMATS: LocalFormat[] = [
  "first",
  "first.last",
  "firstlast",
  "f.last",
  "first_last",
  "firstl",
];

const FORMAT_WEIGHTS: Record<LocalFormat, number> = {
  first: 20,
  "first.last": 35,
  firstlast: 15,
  "f.last": 10,
  first_last: 10,
  firstl: 10,
};

// NOTE: never include `mail` (or other reserved names) here — they collide with the mail
// server host (mail.<domain>) and autodiscover/autoconfig records, creating a duplicate
// A record that breaks the Mailcow API/mail. See RESERVED_PREFIXES below.
const PREFIX_WEIGHTS: Record<string, number> = {
  web: 35,
  app: 25,
  api: 20,
  shop: 15,
  blog: 12,
  dev: 10,
  cloud: 10,
  portal: 8,
  info: 6,
  support: 8,
  news: 5,
  forum: 4,
  cdn: 3,
  static: 3,
  assets: 2,
};

export interface PlanInput {
  totalInboxes: number;
  prefixes: string[];
  names: string[];
  minSubdomains?: number;
  maxSubdomains?: number;
  targetPerSubdomain?: number;
}

export interface PlannedInbox {
  subdomainPrefix: string;
  subdomainFqdn: string;
  localPart: string;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  format: LocalFormat;
}

export interface DomainPlan {
  domain: string;
  totalInboxes: number;
  subdomainCount: number;
  subdomainDistribution: Record<string, number>;
  inboxes: PlannedInbox[];
}

export interface DnsRecordTemplate {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number | null;
  proxied?: boolean;
}

export function generateDnsRecords(
  domainName: string,
  serverIp: string,
  plan: DomainPlan,
): DnsRecordTemplate[] {
  const records: DnsRecordTemplate[] = [];

  // Root template
  records.push({
    type: "A",
    name: "@",
    content: "192.0.2.1",
    ttl: 1,
    proxied: true,
  });

  records.push({
    type: "A",
    name: "mail",
    content: serverIp,
    ttl: 1,
    proxied: false,
  });

  records.push({
    type: "TLSA",
    name: "_25._tcp.mail",
    content: "3 1 1 548b660bef4641fac42f51f21126622e0b96a63257fd2a29ea1acbc96343867e",
    ttl: 1,
    proxied: false,
  });

  records.push({
    type: "TXT",
    name: "_dmarc",
    content: "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@connect.nextusdonateglobal.com,mailto:re+oslk3ai5uf6@dmarc.postmarkapp.com; ruf=mailto:re+oslk3ai5uf6@dmarc.postmarkapp.com; sp=quarantine; aspf=r; adkim=r",
    ttl: 1,
    proxied: false,
  });

  // Subdomain template
  const uniqueSubdomains = [...new Set(plan.inboxes.map((ib) => ib.subdomainPrefix))];
  for (const sub of uniqueSubdomains) {
    records.push({
      type: "A",
      name: sub,
      content: "192.0.2.1",
      ttl: 1,
      proxied: true,
    });

    records.push({
      type: "MX",
      name: sub,
      content: `mail.${domainName}`,
      ttl: 1,
      priority: 10,
    });

    records.push({
      type: "TXT",
      name: sub,
      content: `v=spf1 ip4:${serverIp} -all`,
      ttl: 1,
    });

    records.push({
      type: "TXT",
      name: `_dmarc.${sub}`,
      content: "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@connect.nextusdonateglobal.com,mailto:re+oslk3ai5uf6@dmarc.postmarkapp.com; ruf=mailto:re+oslk3ai5uf6@dmarc.postmarkapp.com; sp=quarantine; aspf=r; adkim=r",
      ttl: 1,
    });

    records.push({
      type: "CNAME",
      name: `autodiscover.${sub}`,
      content: `mail.${domainName}`,
      ttl: 1,
      proxied: false,
    });

    records.push({
      type: "CNAME",
      name: `autoconfig.${sub}`,
      content: `mail.${domainName}`,
      ttl: 1,
      proxied: false,
    });

    records.push({
      type: "SRV",
      name: `_autodiscover._tcp.${sub}`,
      content: `0 443 mail.${domainName}`,
      priority: 0,
      ttl: 1,
    });
  }

  return records;
}

/* ---------- random helpers ---------- */
function rand(): number {
  return Math.random();
}

export function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return rand() * (max - min) + min;
}

function weightedRandom<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export const shuffle = <T>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function sample<T>(arr: T[], count: number): T[] {
  const shuffled = shuffle(arr);
  return shuffled.slice(0, Math.min(count, arr.length));
}

function sampleUnique<T>(arr: T[], count: number): T[] {
  if (count >= arr.length) return shuffle(arr);
  const result: T[] = [];
  const pool = [...arr];
  for (let i = 0; i < count; i++) {
    const idx = randInt(0, pool.length - 1);
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: "User", lastName: "" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function buildLocalPart(name: string, fmt: LocalFormat): string {
  const parts = name.trim().split(/\s+/).map(slugify).filter(Boolean);
  const first = parts[0] ?? "user";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  if (!last) {
    return first;
  }
  switch (fmt) {
    case "first":
      return first;
    case "first.last":
      return `${first}.${last}`;
    case "firstlast":
      return `${first}${last}`;
    case "f.last":
      return `${first[0]}.${last}`;
    case "first_last":
      return `${first}_${last}`;
    case "firstl":
      return `${first}${last[0]}`;
  }
}

function selectWeightedFormat(): LocalFormat {
  const weights = Object.values(FORMAT_WEIGHTS);
  return weightedRandom(FORMATS, weights);
}

function getPrefixWeight(prefix: string): number {
  return PREFIX_WEIGHTS[prefix.toLowerCase()] ?? randInt(1, 5);
}

function selectWeightedPrefix(availablePrefixes: string[]): string {
  const weights = availablePrefixes.map((p) => getPrefixWeight(p));
  return weightedRandom(availablePrefixes, weights);
}

/* ---------- main planner ---------- */
// Subdomain prefixes that must NEVER be used as mailbox subdomains because they collide
// with the mail server host / autodiscovery records and break the Mailcow API and mail.
const RESERVED_PREFIXES = new Set([
  "mail",
  "autodiscover",
  "autoconfig",
  "www",
  "dkim",
  "_dmarc",
  "@",
]);

export function planDomain(domain: string, input: PlanInput): DomainPlan {
  const { totalInboxes, names } = input;
  // Strip reserved names so `mail` (etc.) can never become a sending subdomain.
  const prefixes = input.prefixes.filter((p) => !RESERVED_PREFIXES.has(p.toLowerCase().trim()));
  if (totalInboxes < 1) {
    return { domain, totalInboxes: 0, subdomainCount: 0, subdomainDistribution: {}, inboxes: [] };
  }
  if (prefixes.length === 0) throw new Error("No usable subdomain prefixes provided (after removing reserved names)");
  if (names.length === 0) throw new Error("No names provided");

  const minAllowed = input.minSubdomains ?? 1;
  const maxAllowed = input.maxSubdomains ?? 15;

  let subdomainCount = randInt(minAllowed, maxAllowed);

  if (subdomainCount > prefixes.length) subdomainCount = prefixes.length;

  // Ensure enough subdomains to spread the inboxes naturally (~8 each). With too few, all
  // inboxes still get placed (naturalSplit packs more per subdomain), but we prefer a real
  // spread when we have the prefixes for it. Bounded by available prefixes and maxAllowed.
  const minNeededForSpread = Math.ceil(totalInboxes / 8);
  if (subdomainCount < minNeededForSpread) {
    subdomainCount = Math.min(minNeededForSpread, prefixes.length, maxAllowed);
  }
  // Never plan more subdomains than inboxes (would leave empty subdomains).
  if (subdomainCount > totalInboxes) subdomainCount = totalInboxes;

  const chosenPrefixes = sampleUnique(prefixes, subdomainCount);

  const counts = naturalSplit(totalInboxes, subdomainCount);

  const shuffledNames = shuffle(names);
  const shuffledFormats = shuffle([...FORMATS]);

  const globalSeen = new Set<string>();
  const inboxes: PlannedInbox[] = [];
  const subdomainDistribution: Record<string, number> = {};

  let namePool = [...shuffledNames];
  let formatPool = [...shuffledFormats];

  for (let i = 0; i < chosenPrefixes.length; i++) {
    const prefix = chosenPrefixes[i];
    const fqdn = `${prefix}.${domain}`;
    const subSeen = new Set<string>();
    subdomainDistribution[prefix] = 0;

    for (let n = 0; n < counts[i]; n++) {
      if (namePool.length === 0) {
        namePool = shuffle([...names]);
      }
      const personName = namePool.pop()!;
      subdomainDistribution[prefix]++;

      const parts = personName.trim().split(/\s+/).map(slugify).filter(Boolean);
      const hasLastName = parts.length > 1;

      let fmt: LocalFormat;
      if (!hasLastName) {
        fmt = "first";
      } else {
        if (formatPool.length === 0) {
          formatPool = shuffle([...FORMATS]);
        }
        fmt = formatPool.pop()!;
      }

      const base = buildLocalPart(personName, fmt);

      let candidate = base;
      let suffix = randInt(2, 5);
      let strategy = randInt(0, 2);

      while (subSeen.has(candidate) || globalSeen.has(`${candidate}@${fqdn}`)) {
        switch (strategy % 3) {
          case 0:
            candidate = base + randInt(10, 99);
            break;
          case 1:
            candidate = `${base}${randInt(1, 9)}${String.fromCharCode(97 + randInt(0, 25))}`;
            break;
          default:
            candidate = `${base}_${suffix}`;
            suffix += randInt(1, 3);
        }

        if (suffix > 999) {
          candidate = `${base}${randInt(1000, 9999)}`;
          break;
        }
        strategy++;
      }

      subSeen.add(candidate);
      globalSeen.add(`${candidate}@${fqdn}`);

      const nameParts = splitFullName(personName);

      inboxes.push({
        subdomainPrefix: prefix,
        subdomainFqdn: fqdn,
        localPart: candidate,
        email: `${candidate}@${fqdn}`,
        fullName: personName,
        firstName: nameParts.firstName,
        lastName: nameParts.lastName,
        format: fmt,
      });
    }
  }

  return { domain, totalInboxes, subdomainCount, subdomainDistribution, inboxes };
}

// Distribute `total` inboxes across `buckets` subdomains. INVARIANT: the returned counts ALWAYS
// sum to exactly `total` — no inbox is ever silently dropped. We keep a soft cap (~8 per
// subdomain) for a natural look, but RAISE it automatically when there aren't enough buckets to
// hold `total` (otherwise small subdomain counts would lose inboxes — the cause of "28 planned,
// 8 created").
function naturalSplit(total: number, buckets: number): number[] {
  if (buckets <= 0) return [];
  if (buckets >= total) {
    // One inbox per bucket for the first `total` buckets, rest empty.
    return shuffle(new Array(buckets).fill(0).map((_, i) => (i < total ? 1 : 0)));
  }

  const SOFT_MAX_PER_SUB = 8;
  // Effective cap must be high enough that buckets * cap >= total, so every inbox fits.
  const cap = Math.max(SOFT_MAX_PER_SUB, Math.ceil(total / buckets));

  const result = new Array(buckets).fill(1);
  let remaining = total - buckets;

  let guard = 0;
  while (remaining > 0 && guard < 100000) {
    const pos = randInt(0, buckets - 1);
    if (result[pos] < cap) {
      result[pos]++;
      remaining--;
    }
    guard++;
  }

  // Safety net: if the random walk ever stalls, place any leftover round-robin so the sum is
  // guaranteed to equal `total`.
  let pos = 0;
  while (remaining > 0) {
    result[pos % buckets]++;
    remaining--;
    pos++;
  }

  return shuffle(result);
}

export function parseList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}
