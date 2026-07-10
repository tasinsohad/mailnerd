import { pgTable, text, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import crypto from "crypto";

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSecrets = pgTable("user_secrets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id)
    .unique(),
  cfApiToken: text("cf_api_token"),
  cfAccountId: text("cf_account_id"),
  subdomainPrefixes: text("subdomain_prefixes")
    .array()
    .default(["mail", "contact", "hello", "team", "support", "info"]),
  personNames: text("person_names")
    .array()
    .default(["Alice Johnson", "John Doe", "Marco", "Sofia Rossi"]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const servers = pgTable("servers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  label: text("label").notNull(),
  hostname: text("hostname").notNull(),
  ipAddress: text("ip_address").notNull(),
  sshUser: text("ssh_user").notNull().default("root"),
  sshPassword: text("ssh_password"),
  sshKey: text("ssh_key"),
  status: text("status").notNull().default("configuring"),
  setupSteps: jsonb("setup_steps"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobTemplates = pgTable("job_templates", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  subdomainPrefixes: text("subdomain_prefixes")
    .array()
    .default(["mail", "contact", "hello", "team", "support", "info"]),
  personNames: text("person_names")
    .array()
    .default(["Alice Johnson", "John Doe", "Marco", "Sofia Rossi"]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const domainBatches = pgTable("domain_batches", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  templateId: text("template_id").references(() => jobTemplates.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const domains = pgTable("domains", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  batchId: text("batch_id").references(() => domainBatches.id),
  serverId: text("server_id").references(() => servers.id),
  name: text("name").notNull().unique(),
  status: text("status").notNull().default("pending"),
  ipAddress: text("ip_address"),
  sshUser: text("ssh_user"),
  sshPassword: text("ssh_password"),
  cfZoneId: text("cf_zone_id"),
  cfAccountId: text("cf_account_id"),
  mailcowHostname: text("mailcow_hostname"),
  mailcowApiKey: text("mailcow_api_key"),
  mailcowAdminPassword: text("mailcow_admin_password"), // current admin-panel password (after reset)
  plannedInboxCount: integer("planned_inbox_count"),
  terminalLogs: text("terminal_logs"),
  health: jsonb("health"), // last deliverability health result (see src/server/health.ts)
  healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dnsRecords = pgTable("dns_records", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id),
  type: text("type").notNull(),
  name: text("name").notNull(),
  content: text("content").notNull(),
  ttl: integer("ttl").notNull().default(1),
  priority: integer("priority"),
  proxied: boolean("proxied").notNull().default(false),
  status: text("status").notNull().default("pending"),
  cfRecordId: text("cf_record_id"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const domainPlans = pgTable("domain_plans", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id),
  totalInboxes: integer("total_inboxes").notNull(),
  subdomainCount: integer("subdomain_count").notNull(),
  status: text("status").notNull().default("planned"),
  prefixesSnapshot: text("prefixes_snapshot").array(),
  namesSnapshot: text("names_snapshot").array(),
  placement: text("placement"), // "subdomain" | "main" | "both" (null = subdomain, legacy)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const plannedInboxes = pgTable("planned_inboxes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  domainId: text("domain_id")
    .notNull()
    .references(() => domains.id),
  planId: text("plan_id")
    .notNull()
    .references(() => domainPlans.id),
  subdomainPrefix: text("subdomain_prefix").notNull(),
  subdomainFqdn: text("subdomain_fqdn").notNull(),
  localPart: text("local_part").notNull(),
  email: text("email").notNull(),
  fullName: text("full_name"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  format: text("format"),
  password: text("password"),
  status: text("status").notNull().default("planned"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cloudflareZones = pgTable("cloudflare_zones", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  zoneId: text("zone_id").notNull(),
  name: text("name").notNull(),
  status: text("status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    count: integer("count").notNull().default(0),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserProvider: [table.userId, table.provider],
  }),
);

// Latest deliverability health for a VPS/server, keyed by (userId, ipAddress). Server-level checks
// (outbound port 25, submission ports, Postfix queue, FCrDNS, IP blacklist, TLS, containers) are
// run once per unique IP in a job and stored here, so multiple domains on one VPS share one result.
export const serverHealth = pgTable(
  "server_health",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    ipAddress: text("ip_address").notNull(),
    mailcowHostname: text("mailcow_hostname"),
    health: jsonb("health"), // DomainHealth-shaped result (see src/server/health-types.ts)
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserIp: [table.userId, table.ipAddress],
  }),
);

// Append-only time series of health check results, for trends and "when did it degrade". One row
// per check run per target (a server IP or a domain). Pruned to the newest ~100 rows per target.
export const healthHistory = pgTable("health_history", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  scope: text("scope").notNull(), // "server" | "domain"
  targetKey: text("target_key").notNull(), // ipAddress (server) or domainId (domain)
  targetName: text("target_name"), // ip or domain name, for display
  status: text("status").notNull(),
  score: integer("score").notNull().default(0),
  indicators: jsonb("indicators"), // compact [{id, status}] snapshot
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

// Relations
export const userRelations = relations(users, ({ many }) => ({
  domains: many(domains),
  secrets: many(userSecrets),
  zones: many(cloudflareZones),
  rateLimits: many(rateLimits),
}));

export const domainRelations = relations(domains, ({ one, many }) => ({
  user: one(users, { fields: [domains.userId], references: [users.id] }),
  batch: one(domainBatches, { fields: [domains.batchId], references: [domainBatches.id] }),
  server: one(servers, { fields: [domains.serverId], references: [servers.id] }),
  dnsRecords: many(dnsRecords),
  plan: one(domainPlans, { fields: [domains.id], references: [domainPlans.domainId] }),
}));

export const domainBatchRelations = relations(domainBatches, ({ many, one }) => ({
  domains: many(domains),
  template: one(jobTemplates, {
    fields: [domainBatches.templateId],
    references: [jobTemplates.id],
  }),
}));

export const serverRelations = relations(servers, ({ many }) => ({
  domains: many(domains),
}));

export const jobTemplateRelations = relations(jobTemplates, ({ many }) => ({
  batches: many(domainBatches),
}));

export const domainPlanRelations = relations(domainPlans, ({ many, one }) => ({
  domain: one(domains, { fields: [domainPlans.domainId], references: [domains.id] }),
  inboxes: many(plannedInboxes),
}));

export const plannedInboxRelations = relations(plannedInboxes, ({ one }) => ({
  domain: one(domains, { fields: [plannedInboxes.domainId], references: [domains.id] }),
  plan: one(domainPlans, { fields: [plannedInboxes.planId], references: [domainPlans.id] }),
}));

export const rateLimitRelations = relations(rateLimits, ({ one }) => ({
  user: one(users, { fields: [rateLimits.userId], references: [users.id] }),
}));
