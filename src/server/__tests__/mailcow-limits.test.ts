import { describe, it, expect } from "vitest";
import { mailDomainLimitsFor, currentLimitsFromMailcow, QUOTA } from "../mailcow-helpers";

// Every Mailcow mail domain used to be created (and "repaired") at a fixed 50 mailboxes / 50 GB, so a
// plan with more than 50 on one domain silently lost the rest, and a limit raised by hand was reset.

describe("mailDomainLimitsFor", () => {
  it("uses the standard limits for a normal-sized domain", () => {
    expect(mailDomainLimitsFor(20)).toEqual({ mailboxes: 50, quotaMb: 51200, maxQuotaMb: 10240, raise: true });
  });

  it("raises the mailbox count and the total quota to fit a bigger plan", () => {
    const limits = mailDomainLimitsFor(140);
    expect(limits.mailboxes).toBe(140);
    expect(limits.quotaMb).toBe(140 * QUOTA.MAILBOX_QUOTA_MB);
  });

  it("never lowers limits already raised in Mailcow", () => {
    expect(mailDomainLimitsFor(20, { mailboxes: 200, quotaMb: 300000, maxQuotaMb: 20480 })).toEqual({
      mailboxes: 200,
      quotaMb: 300000,
      maxQuotaMb: 20480,
      raise: false,
    });
  });

  it("only asks for a change when the current limits are too low", () => {
    const current = { mailboxes: 50, quotaMb: 51200, maxQuotaMb: 10240 };
    expect(mailDomainLimitsFor(24, current).raise).toBe(false);
    expect(mailDomainLimitsFor(60, current)).toMatchObject({ mailboxes: 60, quotaMb: 61440, raise: true });
  });

  it("keeps the per-mailbox maximum within the domain total", () => {
    const limits = mailDomainLimitsFor(5, { maxQuotaMb: 999999 });
    expect(limits.maxQuotaMb).toBeLessThanOrEqual(limits.quotaMb);
  });

  it("makes room for the missing mailboxes on top of the ones already on the domain", () => {
    // 45 mailboxes outside the plan already use most of the standard 50, and 20 planned ones are missing.
    const current = { mailboxes: 50, quotaMb: 51200, maxQuotaMb: 10240, mailboxesUsed: 45, quotaUsedMb: 45 * 1024 };
    expect(mailDomainLimitsFor(20, current, 20)).toMatchObject({
      mailboxes: 65,
      quotaMb: 65 * QUOTA.MAILBOX_QUOTA_MB,
      raise: true,
    });
  });

  it("doesn't raise anything when the missing mailboxes fit", () => {
    const current = { mailboxes: 50, quotaMb: 51200, maxQuotaMb: 10240, mailboxesUsed: 11, quotaUsedMb: 11 * 1024 };
    expect(mailDomainLimitsFor(24, current, 13).raise).toBe(false);
  });

  it("assumes every planned mailbox is missing when it can't tell", () => {
    const current = { mailboxes: 50, quotaMb: 51200, maxQuotaMb: 10240, mailboxesUsed: 30 };
    expect(mailDomainLimitsFor(40, current).mailboxes).toBe(70);
  });
});

describe("currentLimitsFromMailcow", () => {
  it("reads the limits from a get/domain row (bytes, sometimes as strings)", () => {
    expect(
      currentLimitsFromMailcow({
        max_num_mboxes_for_domain: 50,
        max_quota_for_domain: 53687091200,
        max_quota_for_mbox: "10737418240",
      }),
    ).toEqual({ mailboxes: 50, quotaMb: 51200, maxQuotaMb: 10240 });
  });

  it("reads how many mailboxes, and how much quota, the domain already uses", () => {
    expect(
      currentLimitsFromMailcow({ mboxes_in_domain: "24", quota_used_in_domain: 24 * 1024 * 1024 * 1024 }),
    ).toMatchObject({ mailboxesUsed: 24, quotaUsedMb: 24 * 1024 });
  });

  it("leaves out fields it can't read", () => {
    expect(currentLimitsFromMailcow({})).toEqual({ mailboxes: undefined, quotaMb: undefined, maxQuotaMb: undefined });
  });
});
