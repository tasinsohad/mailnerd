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
  // An exact split to reproduce (prefix "@" = the main domain), e.g. the wizard's preview replayed on
  // the server. When set, min/maxSubdomains are ignored.
  distribution?: { prefix: string; count: number }[];
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

  // Root-domain mail records — ALWAYS published, even when only subdomains send. Our best-performing
  // zones carry MX, SPF, DMARC and a root DKIM record on the apex regardless of where mailboxes live;
  // it strengthens the domain's sending reputation and covers any mail sent as @<domain>. The root
  // DKIM record (dkim._domainkey.<domain>) is synced from Mailcow in pipeline.ts, like subdomain DKIM.
  records.push({
    type: "MX",
    name: "@",
    content: `mail.${domainName}`,
    ttl: 1,
    priority: 10,
  });

  records.push({
    type: "TXT",
    name: "@",
    content: `v=spf1 ip4:${serverIp} -all`,
    ttl: 1,
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
    // Apex / main-domain mailboxes: the root A, MX, SPF and _dmarc are already added above (root MX/SPF
    // are now unconditional), so here we only add the apex autodiscovery records mailboxes need.
    if (sub === "@") {
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
  // Strip reserved names so `mail` (etc.) can never become a sending subdomain. DNS names ignore case, so
  // "Web" and "web" are one subdomain: lower-case and de-duplicate.
  const prefixes = Array.from(
    new Set(input.prefixes.map((p) => p.trim().toLowerCase()).filter((p) => p && !RESERVED_PREFIXES.has(p))),
  );
  if (totalInboxes < 1) {
    return { domain, totalInboxes: 0, subdomainCount: 0, subdomainDistribution: {}, inboxes: [] };
  }
  const usesSubdomains = placement !== "main";
  // Subdomains only required when we actually place mailboxes on them.
  if (usesSubdomains && prefixes.length === 0)
    throw new Error("No usable subdomain prefixes provided (after removing reserved names)");
  if (names.length === 0) throw new Error("No names provided");

  // An explicit split (the wizard's preview, replayed on the server) is used exactly as given, so what
  // was previewed is what gets created. Otherwise pick subdomains and spread the mailboxes at random.
  const { targets, counts } = input.distribution
    ? explicitSplit(domain, input.distribution, placement, prefixes, totalInboxes)
    : randomSplit(domain, input, placement, prefixes, totalInboxes);

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
      let attempts = 0;
      const taken = (c: string) => subSeen.has(c) || globalSeen.has(`${c}@${fqdn}`);

      while (taken(candidate)) {
        // After some natural-looking tries, draw from a wide number range until the address is unique (the
        // old fallback stopped after one draw, so a big plan with few names could repeat an address).
        if (++attempts > 50) {
          do candidate = `${base}${randInt(1000, 99999)}`;
          while (taken(candidate));
          break;
        }
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

type SplitTarget = { prefix: string; fqdn: string };

function randomSplit(
  domain: string,
  input: PlanInput,
  placement: MailboxPlacement,
  prefixes: string[],
  totalInboxes: number,
): { targets: SplitTarget[]; counts: number[] } {
  const usesSubdomains = placement !== "main";
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
  const targets: SplitTarget[] = [];
  if (placement === "main" || placement === "both") targets.push({ prefix: "@", fqdn: domain });
  if (placement === "subdomain" || placement === "both")
    for (const p of chosenPrefixes) targets.push({ prefix: p, fqdn: `${p}.${domain}` });
  if (targets.length === 0) targets.push({ prefix: "@", fqdn: domain }); // safety net

  return { targets, counts: naturalSplit(totalInboxes, targets.length) };
}

// Validate and use a given split. Throws a message fit to show the user when it can't be honoured.
function explicitSplit(
  domain: string,
  distribution: { prefix: string; count: number }[],
  placement: MailboxPlacement,
  prefixes: string[],
  totalInboxes: number,
): { targets: SplitTarget[]; counts: number[] } {
  const targets: SplitTarget[] = [];
  const counts: number[] = [];
  const seen = new Set<string>();
  let sum = 0;

  for (const entry of distribution) {
    const prefix = entry.prefix.trim().toLowerCase();
    if (!Number.isInteger(entry.count) || entry.count < 0) throw new Error(`Invalid mailbox count for ${prefix}`);
    if (seen.has(prefix.toLowerCase())) throw new Error(`${prefix} appears twice in the planned split`);
    seen.add(prefix.toLowerCase());
    sum += entry.count;
    if (entry.count === 0) continue;

    if (prefix === "@") {
      if (placement === "subdomain")
        throw new Error("The planned split uses the main domain, but placement is subdomains only");
      targets.push({ prefix: "@", fqdn: domain });
    } else {
      if (placement === "main")
        throw new Error(`The planned split uses the subdomain ${prefix}, but placement is main domain only`);
      if (RESERVED_PREFIXES.has(prefix.toLowerCase()))
        throw new Error(`${prefix} is a reserved name and can't hold mailboxes`);
      if (!prefixes.includes(prefix)) throw new Error(`${prefix} is not one of this batch's subdomain prefixes`);
      targets.push({ prefix, fqdn: `${prefix}.${domain}` });
    }
    counts.push(entry.count);
  }

  if (sum !== totalInboxes) throw new Error(`The planned split adds up to ${sum}, not ${totalInboxes}`);
  return { targets, counts };
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
  // Never past what the server accepts for one domain (callers validate total <= that limit x domainCount).
  const cap = Math.min(MAX_INBOXES_PER_DOMAIN, Math.max(2, Math.ceil(average * 3)));

  // 1. random weights → 2. proportional raw allocation (sums to `total`)
  const weights = new Array(domainCount).fill(0).map(() => randFloat(0.4, 1.6));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / weightSum) * total);

  // 3. floor with a floor-of-1, within the cap, then fix the drift so the sum is exact
  const result = raw.map((x) => Math.min(cap, Math.max(1, Math.floor(x))));
  let remainder = total - result.reduce((a, b) => a + b, 0);

  if (remainder > 0) {
    // hand out the surplus to the largest fractional parts, respecting the cap. Usually one each; a large
    // shortfall left by the cap goes out in bigger chunks so it's placed within a few passes.
    const order = raw
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac);
    let k = 0;
    while (remainder > 0 && k < domainCount * 1000) {
      const idx = order[k % order.length].i;
      const add = Math.min(cap - result[idx], remainder, Math.max(1, Math.ceil(remainder / domainCount)));
      if (add > 0) {
        result[idx] += add;
        remainder -= add;
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

// How the wizard turns the user's numbers into per-domain mailbox counts.
export type InboxCountMode = "even" | "random" | "fixed" | "range" | "manual";

export interface InboxCountSettings {
  mode: InboxCountMode;
  total?: number; // even, random: mailboxes for the whole batch
  perDomain?: number; // fixed
  min?: number; // range
  max?: number; // range
  manual?: number[]; // manual: one count per domain, in domain order
}

const MAX_INBOXES_PER_DOMAIN = 10000; // matches the server's limit

/** `total` split as evenly as possible: floor(total / n) each, and the first `total % n` domains get one more. */
export function splitEvenly(total: number, domainCount: number): number[] {
  if (domainCount <= 0) return [];
  const base = Math.floor(total / domainCount);
  const extra = total - base * domainCount;
  return Array.from({ length: domainCount }, (_, i) => base + (i < extra ? 1 : 0));
}

/** What's wrong with these count settings for `domainCount` domains, in words the wizard shows, or null. */
export function inboxCountSettingsError(s: InboxCountSettings, domainCount: number): string | null {
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  const atLeast = Math.max(1, domainCount);
  switch (s.mode) {
    case "even":
    case "random":
      if (!whole(s.total)) return "Total mailboxes must be a whole number";
      if (s.total < atLeast) return `Total mailboxes must be at least ${atLeast} so every domain gets one`;
      if (s.total > MAX_INBOXES_PER_DOMAIN * atLeast)
        return `That's more than ${MAX_INBOXES_PER_DOMAIN} mailboxes per domain`;
      return null;
    case "fixed":
      if (!whole(s.perDomain)) return "Mailboxes per domain must be a whole number";
      if (s.perDomain < 1) return "Mailboxes per domain must be at least 1";
      if (s.perDomain > MAX_INBOXES_PER_DOMAIN) return `Mailboxes per domain can be at most ${MAX_INBOXES_PER_DOMAIN}`;
      return null;
    case "range":
      if (!whole(s.min) || !whole(s.max)) return "Min and max mailboxes must be whole numbers";
      if (s.min < 1) return "Min mailboxes must be at least 1";
      if (s.max < s.min) return "Max mailboxes must be at least the min";
      if (s.max > MAX_INBOXES_PER_DOMAIN) return `Max mailboxes can be at most ${MAX_INBOXES_PER_DOMAIN}`;
      return null;
    case "manual": {
      const counts = s.manual ?? [];
      if (counts.length !== domainCount) return "Enter a mailbox count for every domain";
      if (counts.some((n) => !whole(n))) return "Mailbox counts must be whole numbers";
      if (counts.some((n) => n < 1)) return "Every domain needs at least 1 mailbox";
      if (counts.some((n) => n > MAX_INBOXES_PER_DOMAIN))
        return `A domain can have at most ${MAX_INBOXES_PER_DOMAIN} mailboxes`;
      return null;
    }
    default:
      return "Choose how to count mailboxes";
  }
}

/** Per-domain mailbox counts for the chosen mode. Throws inboxCountSettingsError's message when invalid. */
export function allocateInboxes(s: InboxCountSettings, domainCount: number): number[] {
  const error = inboxCountSettingsError(s, domainCount);
  if (error) throw new Error(error);
  switch (s.mode) {
    case "even":
      return splitEvenly(s.total!, domainCount);
    case "random":
      return allocateInboxesAcrossDomains(s.total!, domainCount);
    case "fixed":
      return new Array(domainCount).fill(s.perDomain!);
    case "range":
      return Array.from({ length: domainCount }, () => randInt(s.min!, s.max!));
    case "manual":
      return [...s.manual!];
    default:
      throw new Error("Choose how to count mailboxes");
  }
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
