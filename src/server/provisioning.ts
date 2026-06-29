import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { NodeSSH } from "node-ssh";
import { addServerSetupJob } from "./queue";
import { mailcowSsha256, generateMailboxPassword } from "./mailcow-helpers";

export const testSshConnection = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { success: false, error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      with: { server: true },
    });

    if (!domain) return { success: false, error: "Domain not found" };

    // Must use the SAME precedence as provisionServer below (domain-first), so the
    // "Test SSH" button validates the exact credentials provisioning will send.
    // A mismatch here meant a test could pass with one password while provisioning
    // sent another, causing repeated failed logins that lock out the server.
    const ipAddress = domain.ipAddress || domain.server?.ipAddress;
    const sshUser = domain.sshUser || domain.server?.sshUser;
    const sshPassword = domain.sshPassword || domain.server?.sshPassword;

    if (!ipAddress || !sshUser) {
      return { success: false, error: "SSH credentials not configured for this domain" };
    }

    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: ipAddress,
        username: sshUser,
        password: sshPassword || undefined,
        readyTimeout: 10000,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    } finally {
      ssh.dispose();
    }
  });

// Reset the Mailcow admin-panel password. The Mailcow API key cannot change the superadmin
// password, so we SSH in and update the `admin` table directly with a Mailcow-compatible
// {SSHA256} hash, then store the plaintext so the UI can show the current credential.
export const resetMailcowAdminPassword = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ domainId: z.string(), newPassword: z.string().min(8).max(128).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      with: { server: true },
    });
    if (!domain) return { error: "Domain not found" };
    if (!domain.mailcowHostname) return { error: "Mailcow is not provisioned for this domain yet" };

    const ipAddress = domain.ipAddress || domain.server?.ipAddress;
    const sshUser = domain.sshUser || domain.server?.sshUser;
    const sshPassword = domain.sshPassword || domain.server?.sshPassword;
    if (!ipAddress || !sshUser) return { error: "SSH credentials not configured for this domain" };

    const password = data.newPassword || generateMailboxPassword();
    const hash = mailcowSsha256(password); // contains only base64 + {SSHA256} — shell/SQL safe
    const sql = `UPDATE admin SET password='${hash}' WHERE username='admin';`;
    const cmd = [
      "cd /opt/mailcow-dockerized 2>/dev/null || cd ~/mailcow-dockerized 2>/dev/null || cd mailcow-dockerized",
      "set -a; . ./mailcow.conf; set +a",
      `docker compose exec -T mysql-mailcow mysql -u"$DBUSER" -p"$DBPASS" "$DBNAME" -e "${sql}"`,
    ].join(" && ");

    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: ipAddress,
        username: sshUser,
        password: sshPassword || undefined,
        readyTimeout: 20000,
      });
      const res = await ssh.execCommand(cmd);
      if (res.code !== 0) {
        return { error: `Failed to update password: ${res.stderr || res.stdout || "unknown error"}` };
      }
      await db
        .update(domains)
        .set({ mailcowAdminPassword: password })
        .where(eq(domains.id, domain.id));
      return { success: true, password };
    } catch (error) {
      return { error: `SSH error: ${String(error)}` };
    } finally {
      ssh.dispose();
    }
  });

export const provisionServer = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ domainId: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { db, userId } = context as any;
    if (!db) return { error: "Database not connected" };

    console.log(`[provisionServer] Processing domainId: ${data.domainId} for userId: ${userId}`);

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      with: { server: true },
    });

    if (!domain) {
      console.log(`[provisionServer] Domain not found!`);
      return { error: "Domain not found" };
    }

    const ipAddress = domain.ipAddress || domain.server?.ipAddress;
    const sshUser = domain.sshUser || domain.server?.sshUser;
    const sshPassword = domain.sshPassword || domain.server?.sshPassword;

    if (!ipAddress || !sshUser) {
      return { error: "Server credentials not configured for this domain" };
    }

    try {
      console.log(`[provisionServer] Enqueuing job for IP: ${ipAddress}`);
      // Enqueue job via BullMQ
      const job = await addServerSetupJob(
        domain.id,
        ipAddress,
        sshUser,
        sshPassword,
        domain.name,
      );

      console.log(`[provisionServer] Job enqueued: ${job.jobId}, updating DB status to provisioning`);
      await db.update(domains).set({ status: "provisioning" }).where(eq(domains.id, domain.id));

      console.log(`[provisionServer] Done, returning to client.`);
      return { success: true, jobId: job.jobId };
    } catch (error) {
      await db.update(domains).set({ status: "error" }).where(eq(domains.id, domain.id));
      return { success: false, error: String(error) };
    }
  });
