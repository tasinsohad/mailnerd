import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { userSecrets } from "@/lib/db/schema";
import { ConsoleLog } from "./console-bus";
import { readMailcowConfigOverSsh } from "./mailcow-key";
import { mailcowRequest, cfTxtContent, isCfAlreadyExistsError } from "./mailcow-helpers";
import { listCfZones, fetchAllCfDnsRecords, createCfDnsRecordResilient } from "./cloudflare.functions";

// Bulk external DNS setup: the user adds a server (IP + SSH, like the Troubleshoot flow) and pastes
// domains/subdomains; for each we create the MISSING essential mail records (MX / SPF / DKIM /
// DMARC) on Cloudflare. Idempotent — an already-present record is adopted, never duplicated.
//
// SERVER-ONLY, and this file exports ONLY a createServerFn (plus types), so TanStack Start stubs
// the whole module out of the client bundle — that's what keeps its native imports (mailcow-key →
// node-ssh) out of the browser. Never add a plain runtime export here (see server-fixes.ts:41).

export type BulkDnsResult = {
  name: string;
  zone?: string;
  zoneMissing?: boolean;
  created: string[];
  present: string[];
  skipped: string[];
  failed: { record: string; error: string }[];
};

// Fetch every zone in the account (paginated), lowercased for suffix matching.
async function fetchAllZones(token: string): Promise<{ id: string; name: string }[]> {
  const zones: { id: string; name: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const resp = await listCfZones(token, undefined, page, 50);
    if (!resp.success || !resp.result || resp.result.length === 0) break;
    zones.push(...resp.result.map((z) => ({ id: z.id, name: z.name.toLowerCase() })));
    if (resp.result.length < 50) break;
  }
  return zones;
}

// The zone that OWNS a name — the longest zone suffix (so a subdomain resolves to its registrable
// zone, e.g. us1.example.com → example.com).
function zoneForName(
  zones: { id: string; name: string }[],
  name: string,
): { id: string; name: string } | null {
  let best: { id: string; name: string } | null = null;
  for (const z of zones) {
    if (name === z.name || name.endsWith(`.${z.name}`)) {
      if (!best || z.name.length > best.name.length) best = z;
    }
  }
  return best;
}

export const bulkSetupDns = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        ipAddress: z.string().trim().min(1),
        sshUser: z.string().trim().min(1).default("root"),
        sshPassword: z.string().min(1),
        mailcowHostname: z.string().trim().optional(),
        mailcowApiKey: z.string().trim().optional(),
        fetchApiKey: z.boolean().default(true),
        names: z.array(z.string().trim().min(1)).min(1),
        runId: z.string().trim().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    const log = new ConsoleLog(data.runId);
    if (!db) return { error: "Database not connected", transcript: log.transcript() };

    const secrets = await db.query.userSecrets.findFirst({ where: eq(userSecrets.userId, userId) });
    if (!secrets?.cfApiToken)
      return { error: "No Cloudflare token in Settings — add one first.", transcript: log.transcript() };
    const token = secrets.cfApiToken;

    // Source the mail host (MX/SPF target) and DKIM keys from the server, fetching over SSH when the
    // hostname / API key weren't supplied — same as the Troubleshoot flow.
    const target = { ipAddress: data.ipAddress, sshUser: data.sshUser, sshPassword: data.sshPassword };
    const needHost = !data.mailcowHostname;
    const wantApiKey = !data.mailcowApiKey && data.fetchApiKey;
    let mailHost = data.mailcowHostname || null;
    let apiKey = data.mailcowApiKey || null;
    if (needHost || wantApiKey) {
      log.info(`Connecting to ${data.ipAddress} for the mail host${wantApiKey ? " + DKIM key" : ""}…`);
      const cfg = await readMailcowConfigOverSsh(target, { wantApiKey, log });
      mailHost = mailHost || cfg.hostname;
      apiKey = apiKey || cfg.apiKey;
    }
    if (!mailHost)
      return {
        error: "Could not determine the mail host — enter it under Advanced and retry.",
        transcript: log.transcript(),
      };

    const serverIp = data.ipAddress;
    const zones = await fetchAllZones(token);
    const names = [...new Set(data.names.map((n) => n.toLowerCase().trim().replace(/\.$/, "")))].filter(
      Boolean,
    );
    // Always give each zone's ROOT the same essential mail records, even when only subdomains were
    // pasted: our best-performing zones publish MX/SPF/DMARC/DKIM on the apex regardless of where mail
    // is sent from. Idempotent — an already-present record is adopted below, never duplicated.
    const withRoots = new Set(names);
    for (const name of names) {
      const zone = zoneForName(zones, name);
      if (zone) withRoots.add(zone.name);
    }
    const targetNames = [...withRoots];
    log.info(`${zones.length} Cloudflare zones available. Processing ${targetNames.length} name(s).`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zoneRecordsCache = new Map<string, any[]>();
    const results: BulkDnsResult[] = [];

    for (const name of targetNames) {
      const zone = zoneForName(zones, name);
      if (!zone) {
        log.error(`${name}: no matching Cloudflare zone in this account — skipped.`);
        results.push({ name, zoneMissing: true, created: [], present: [], skipped: [], failed: [] });
        continue;
      }
      let existing = zoneRecordsCache.get(zone.id);
      if (!existing) {
        existing = await fetchAllCfDnsRecords(token, zone.id);
        zoneRecordsCache.set(zone.id, existing);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const has = (type: string, fullName: string, pred?: (c: string) => boolean) =>
        existing!.some(
          (r: any) =>
            r.type === type &&
            String(r.name).toLowerCase() === fullName.toLowerCase() &&
            (!pred || pred(String(r.content))),
        );

      const created: string[] = [];
      const present: string[] = [];
      const skipped: string[] = [];
      const failed: { record: string; error: string }[] = [];

      const ensure = async (
        label: string,
        type: string,
        fullName: string,
        content: string,
        alreadyPresent: boolean,
        priority?: number,
      ) => {
        if (alreadyPresent) {
          present.push(label);
          log.out(`${name}: ${label} already present.`);
          return;
        }
        log.cmd(`Create ${label} → ${fullName}`);
        const body: Record<string, unknown> = {
          type,
          name: fullName,
          content: type === "TXT" ? cfTxtContent("TXT", content) : content,
          ttl: 1,
          ...(priority !== undefined ? { priority } : {}),
        };
        const r = await createCfDnsRecordResilient(token, zone.id, body);
        if (r.success || (r.errors?.[0] && isCfAlreadyExistsError(r.errors[0].message))) {
          created.push(label);
          log.out(`${name}: ${label} created.`);
        } else {
          const err = r.errors?.[0]?.message || `HTTP ${r.status}`;
          failed.push({ record: label, error: err });
          log.error(`${name}: ${label} failed — ${err}`);
        }
      };

      await ensure("MX", "MX", name, mailHost, has("MX", name), 10);
      await ensure("SPF", "TXT", name, `v=spf1 ip4:${serverIp} -all`, has("TXT", name, (c) => /v=spf1/i.test(c)));
      await ensure(
        "DMARC",
        "TXT",
        `_dmarc.${name}`,
        "v=DMARC1; p=quarantine; sp=quarantine; aspf=r; adkim=r",
        has("TXT", `_dmarc.${name}`, (c) => /v=dmarc1/i.test(c)),
      );

      // DKIM needs the signing key from Mailcow (get/dkim/<name>); if Mailcow has no key for this
      // name (it isn't a Mailcow domain), that's a skip with a note — not a failure.
      const dkimName = `dkim._domainkey.${name}`;
      if (has("TXT", dkimName)) {
        present.push("DKIM");
        log.out(`${name}: DKIM already present.`);
      } else if (apiKey && mailHost) {
        let dkimContent: string | null = null;
        try {
          const { json } = await mailcowRequest(mailHost, apiKey, `get/dkim/${name}`, undefined, {
            timeoutMs: 8000,
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dkimTxt = (json as any)?.dkim_txt;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pubkey = (json as any)?.pubkey;
          if (dkimTxt && /v=dkim1/i.test(String(dkimTxt)))
            dkimContent = String(dkimTxt).replace(/[\r\n]/g, "");
          else if (pubkey)
            dkimContent = `v=DKIM1;k=rsa;t=s;s=email;p=${String(pubkey).replace(/[\r\n]/g, "")}`;
        } catch {
          /* no key */
        }
        if (dkimContent) await ensure("DKIM", "TXT", dkimName, dkimContent, false);
        else {
          skipped.push("DKIM (no Mailcow key for this name)");
          log.info(`${name}: no DKIM key in Mailcow — add the domain to Mailcow first, then re-run.`);
        }
      } else {
        skipped.push("DKIM (no Mailcow API key)");
      }

      results.push({ name, zone: zone.name, created, present, skipped, failed });
    }

    const totalCreated = results.reduce((n, r) => n + r.created.length, 0);
    log.info(`Bulk DNS setup finished — ${totalCreated} record(s) created across ${targetNames.length} name(s).`);
    return { mailHost, results, transcript: log.transcript() };
  });
