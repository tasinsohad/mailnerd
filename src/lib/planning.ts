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

// Where mailboxes live: on the root/main domain (user@example.com), on subdomains
// (user@web.example.com), or split across both.
export type MailboxPlacement = "subdomain" | "main" | "both";

export interface PlanInput {
  totalInboxes: number;
  prefixes: string[];
  names: string[];
  minSubdomains?: number;
  maxSubdomains?: number;
  targetPerSubdomain?: number;
  placement?: MailboxPlacement; // default "subdomain" (unchanged behaviour)
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
    // Apex / main-domain mailboxes: the root A and root _dmarc are already added above, so here
    // we only add the records the apex needs to send/receive mail (MX, SPF, autodiscovery).
    if (sub === "@") {
      records.push({ type: "MX", name: "@", content: `mail.${domainName}`, ttl: 1, priority: 10 });
      records.push({ type: "TXT", name: "@", content: `v=spf1 ip4:${serverIp} -all`, ttl: 1 });
      records.push({ type: "CNAME", name: "autodiscover", content: `mail.${domainName}`, ttl: 1, proxied: false });
      records.push({ type: "CNAME", name: "autoconfig", content: `mail.${domainName}`, ttl: 1, proxied: false });
      records.push({ type: "SRV", name: `_autodiscover._tcp`, content: `0 443 mail.${domainName}`, priority: 0, ttl: 1 });
      continue;
    }

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
  const placement: MailboxPlacement = input.placement ?? "subdomain";
  // Strip reserved names so `mail` (etc.) can never become a sending subdomain.
  const prefixes = input.prefixes.filter((p) => !RESERVED_PREFIXES.has(p.toLowerCase().trim()));
  if (totalInboxes < 1) {
    return { domain, totalInboxes: 0, subdomainCount: 0, subdomainDistribution: {}, inboxes: [] };
  }
  const usesSubdomains = placement !== "main";
  // Subdomains only required when we actually place mailboxes on them.
  if (usesSubdomains && prefixes.length === 0)
    throw new Error("No usable subdomain prefixes provided (after removing reserved names)");
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
  if (subdomainCount < 1) subdomainCount = Math.min(1, prefixes.length);

  const chosenPrefixes = usesSubdomains ? sampleUnique(prefixes, subdomainCount) : [];

  // Distribution targets = the mail domains mailboxes are spread across. The root/main domain
  // is the apex (prefix "@", fqdn = the domain itself); subdomains are prefix.domain.
  const targets: { prefix: string; fqdn: string }[] = [];
  if (placement === "main" || placement === "both") targets.push({ prefix: "@", fqdn: domain });
  if (placement === "subdomain" || placement === "both")
    for (const p of chosenPrefixes) targets.push({ prefix: p, fqdn: `${p}.${domain}` });
  if (targets.length === 0) targets.push({ prefix: "@", fqdn: domain }); // safety net

  const counts = naturalSplit(totalInboxes, targets.length);

  const shuffledNames = shuffle(names);
  const shuffledFormats = shuffle([...FORMATS]);

  const globalSeen = new Set<string>();
  const inboxes: PlannedInbox[] = [];
  const subdomainDistribution: Record<string, number> = {};

  let namePool = [...shuffledNames];
  let formatPool = [...shuffledFormats];

  for (let i = 0; i < targets.length; i++) {
    const prefix = targets[i].prefix;
    const fqdn = targets[i].fqdn;
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

  // Report the number of mail domains actually used (apex counts as one).
  return { domain, totalInboxes, subdomainCount: targets.length, subdomainDistribution, inboxes };
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

// Split a batch `total` of inboxes across `domainCount` domains for the wizard's "exact total"
// mode. INVARIANTS: length === domainCount; sum === total; every entry >= 1 when total >=
// domainCount. Unlike naturalSplit (tuned to ~8 per subdomain, which collapses to near-even at
// domain scale), this uses random weights so the per-domain counts are visibly varied, with a
// soft per-domain cap so no single domain swallows the batch.
export function allocateInboxesAcrossDomains(total: number, domainCount: number): number[] {
  if (domainCount <= 0) return [];
  if (total <= 0) return new Array(domainCount).fill(0);
  if (total <= domainCount) {
    // one inbox to the first `total` domains (shuffled), rest zero
    return shuffle(new Array(domainCount).fill(0).map((_, i) => (i < total ? 1 : 0)));
  }

  const average = total / domainCount;
  const cap = Math.max(2, Math.ceil(average * 3));

  // 1. random weights → 2. proportional raw allocation (sums to `total`)
  const weights = new Array(domainCount).fill(0).map(() => randFloat(0.4, 1.6));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / weightSum) * total);

  // 3. floor with a floor-of-1, then fix the rounding drift so the sum is exact
  const result = raw.map((x) => Math.max(1, Math.floor(x)));
  let remainder = total - result.reduce((a, b) => a + b, 0);

  if (remainder > 0) {
    // hand out the surplus to the largest fractional parts, respecting the cap
    const order = raw
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac);
    let k = 0;
    while (remainder > 0 && k < domainCount * 1000) {
      const idx = order[k % order.length].i;
      if (result[idx] < cap) {
        result[idx]++;
        remainder--;
      }
      k++;
    }
  } else if (remainder < 0) {
    // over-allocated (many tiny weights bumped up to 1) — trim from the largest buckets
    const order = result.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
    let k = 0;
    while (remainder < 0 && k < domainCount * 1000) {
      const idx = order[k % order.length].i;
      if (result[idx] > 1) {
        result[idx]--;
        remainder++;
      }
      k++;
    }
  }

  return result;
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
