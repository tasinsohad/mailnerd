import { describe, it, expect } from "vitest";
import {
  runMailboxCreation,
  RETRY_DELAYS_MS,
  type InboxToCreate,
  type MailboxCreationDeps,
} from "../mailbox-creation";

// Regression: dentimaxfirst.com ended with 24 mailboxes in Mailcow but only 11 marked created in the
// app. The other 13 had no saved password (passwords were only stored after a final check that never
// ran), and nothing retried them or said so.

const inbox = (n: number, extra: Partial<InboxToCreate> = {}): InboxToCreate => ({
  id: `id${n}`,
  email: `user${n}@example.com`,
  localPart: `user${n}`,
  mailDomain: "example.com",
  displayName: `User ${n}`,
  hasPassword: false,
  ...extra,
});

// A fake Mailcow and database. rejectTimes[email] makes that mailbox's add/password call fail that many
// times before succeeding; ghost mailboxes are "accepted" but never appear in Mailcow's list.
// ambiguous mailboxes are created by the first add, which still reports a failure (a timeout after Mailcow
// acted). listFailsFrom makes every list read from that call number on (1-based) fail.
function fakeWorld(
  opts: {
    existing?: string[];
    rejectTimes?: Record<string, number>;
    missingDomains?: string[];
    ghost?: string[];
    ambiguous?: string[];
    listFails?: boolean;
    listFailsFrom?: number;
  } = {},
) {
  const mailboxes = new Set(opts.existing ?? []);
  const rejects = { ...(opts.rejectTimes ?? {}) };
  const ambiguous = new Set(opts.ambiguous ?? []);
  const log: string[] = [];
  const passwordsSent: string[] = [];
  const passwords = new Map<string, string>();
  const status = new Map<string, string>();
  const sleeps: number[] = [];
  let counter = 0;
  let listCalls = 0;
  const failOnce = (email: string) => {
    if ((rejects[email] ?? 0) > 0) {
      rejects[email]--;
      return true;
    }
    return false;
  };

  const deps: MailboxCreationDeps = {
    listMailboxes: async () => {
      log.push("list");
      listCalls++;
      if (opts.listFails || (opts.listFailsFrom !== undefined && listCalls >= opts.listFailsFrom)) return null;
      return new Set(mailboxes);
    },
    mailDomainExists: (fqdn) => !(opts.missingDomains ?? []).includes(fqdn),
    addMailbox: async (ib, password) => {
      log.push(`add ${ib.email}`);
      passwordsSent.push(`${ib.email} ${password}`);
      if (ambiguous.delete(ib.email)) {
        mailboxes.add(ib.email);
        return { ok: false, error: "timed out" };
      }
      if (failOnce(ib.email)) return { ok: false, error: "quota exceeded" };
      if (!(opts.ghost ?? []).includes(ib.email)) mailboxes.add(ib.email);
      return { ok: true };
    },
    setPassword: async (ib, password) => {
      log.push(`reset ${ib.email}`);
      passwordsSent.push(`${ib.email} ${password}`);
      if (failOnce(ib.email)) return { ok: false, error: "busy" };
      return { ok: true };
    },
    savePassword: async (id, password) => {
      log.push(`save ${id}`);
      passwords.set(id, password);
    },
    clearPasswords: async (ids) => {
      for (const id of ids) passwords.delete(id);
    },
    markActive: async (ids) => {
      for (const id of ids) status.set(id, "active");
    },
    markFailed: async (ids) => {
      for (const id of ids) status.set(id, "failed");
    },
    newPassword: () => `pw${++counter}`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, log, passwords, passwordsSent, status, sleeps };
}

describe("runMailboxCreation", () => {
  it("retries 3 times by default, waiting longer each round", () => {
    expect(RETRY_DELAYS_MS).toHaveLength(3);
    expect([...RETRY_DELAYS_MS].sort((a, b) => a - b)).toEqual([...RETRY_DELAYS_MS]);
  });

  it("creates every mailbox and saves each password the moment Mailcow accepts it", async () => {
    const world = fakeWorld();
    const result = await runMailboxCreation([inbox(1), inbox(2)], world.deps);

    expect(world.log).toEqual([
      "list",
      "add user1@example.com",
      "save id1",
      "add user2@example.com",
      "save id2",
      "list",
    ]);
    expect(result).toMatchObject({ total: 2, created: 2, failed: [] });
    expect(world.status.get("id1")).toBe("active");
    expect(world.passwords.get("id2")).toBe("pw2");
  });

  it("leaves a finished mailbox alone", async () => {
    const world = fakeWorld({ existing: ["user1@example.com"] });
    const result = await runMailboxCreation([inbox(1, { hasPassword: true })], world.deps);

    expect(world.log.filter((l) => l.startsWith("add") || l.startsWith("reset"))).toEqual([]);
    expect(world.status.get("id1")).toBe("active");
    expect(result.created).toBe(1);
  });

  it("gives a mailbox that exists without a saved password a new password instead of re-adding it", async () => {
    const world = fakeWorld({ existing: ["user1@example.com"] });
    const result = await runMailboxCreation([inbox(1)], world.deps);

    expect(world.log).toContain("reset user1@example.com");
    expect(world.log).not.toContain("add user1@example.com");
    expect(world.passwords.get("id1")).toBeDefined();
    expect(result).toMatchObject({ created: 1, failed: [] });
  });

  it("retries a rejected mailbox 3 more times, then lists it as failed with Mailcow's reason", async () => {
    const world = fakeWorld({ rejectTimes: { "user1@example.com": 99 } });
    const result = await runMailboxCreation([inbox(1), inbox(2)], world.deps);

    expect(world.log.filter((l) => l === "add user1@example.com")).toHaveLength(4);
    expect(world.sleeps).toEqual([...RETRY_DELAYS_MS]);
    expect(result.failed).toEqual([{ email: "user1@example.com", error: "quota exceeded" }]);
    expect(result.created).toBe(1);
    expect(world.status.get("id1")).toBe("failed");
    expect(world.status.get("id2")).toBe("active");
  });

  it("stops retrying as soon as the mailbox goes through", async () => {
    const world = fakeWorld({ rejectTimes: { "user1@example.com": 1 } });
    const result = await runMailboxCreation([inbox(1)], world.deps);

    expect(world.sleeps).toEqual([RETRY_DELAYS_MS[0]]);
    expect(result).toMatchObject({ created: 1, failed: [] });
  });

  it("doesn't call Mailcow for a mailbox whose mail domain is missing, and says why", async () => {
    const world = fakeWorld({ missingDomains: ["example.com"] });
    const result = await runMailboxCreation([inbox(1)], world.deps);

    expect(world.log.filter((l) => l.startsWith("add"))).toEqual([]);
    expect(result.failed[0].error).toMatch(/example\.com/);
    expect(world.status.get("id1")).toBe("failed");
  });

  it("changes nothing when Mailcow's mailbox list can't be read", async () => {
    const world = fakeWorld({ listFails: true });
    await expect(runMailboxCreation([inbox(1)], world.deps)).rejects.toThrow(/mailbox list/i);
    expect(world.log).toEqual(["list"]);
    expect(world.status.size).toBe(0);
  });

  it("treats 'accepted but never appears' as failed and drops the unusable password", async () => {
    const world = fakeWorld({ ghost: ["user1@example.com"] });
    const result = await runMailboxCreation([inbox(1)], world.deps);

    expect(result.failed[0].error).toMatch(/isn't in/i);
    expect(world.passwords.has("id1")).toBe(false);
    expect(world.status.get("id1")).toBe("failed");
  });

  it("uses one password per mailbox for the whole run, so a retry can't leave a different one saved", async () => {
    const world = fakeWorld({ rejectTimes: { "user1@example.com": 2 } });
    await runMailboxCreation([inbox(1)], world.deps);

    expect(world.passwordsSent).toEqual([
      "user1@example.com pw1",
      "user1@example.com pw1",
      "user1@example.com pw1",
    ]);
    expect(world.passwords.get("id1")).toBe("pw1");
    expect(world.status.get("id1")).toBe("active");
  });

  it("doesn't trust an old saved password for a mailbox that wasn't in Mailcow", async () => {
    // The add times out after Mailcow created the mailbox with this run's password, so the old saved one is wrong.
    const world = fakeWorld({ ambiguous: ["user1@example.com"] });
    const result = await runMailboxCreation([inbox(1, { hasPassword: true })], world.deps);

    expect(world.log).toContain("reset user1@example.com");
    expect(world.passwords.get("id1")).toBe("pw1");
    expect(world.status.get("id1")).toBe("active");
    expect(result.created).toBe(1);
  });

  it("doesn't re-add a mailbox Mailcow accepted while waiting for its list to show it", async () => {
    const world = fakeWorld({ ghost: ["user1@example.com"] });
    await runMailboxCreation([inbox(1)], world.deps);

    expect(world.log.filter((l) => l === "add user1@example.com")).toHaveLength(1);
  });

  it("leaves a mailbox Mailcow accepted as it is when the list can't be read to confirm it", async () => {
    const world = fakeWorld({ listFailsFrom: 2 });
    const result = await runMailboxCreation([inbox(1)], world.deps);

    expect(world.status.has("id1")).toBe(false);
    expect(world.passwords.get("id1")).toBe("pw1");
    expect(result.created).toBe(0);
    expect(result.failed[0].error).toMatch(/couldn't be read/i);
  });

  it("still marks a rejected mailbox failed when the list can't be read at the end", async () => {
    const world = fakeWorld({ listFailsFrom: 2, rejectTimes: { "user1@example.com": 99 } });
    const result = await runMailboxCreation([inbox(1)], world.deps);

    expect(world.status.get("id1")).toBe("failed");
    expect(result.failed[0].error).toBe("quota exceeded");
  });
});
