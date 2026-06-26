import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth";
import { z } from "zod";
import { domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { NodeSSH } from "node-ssh";
import { addServerSetupJob } from "./queue";

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

    const ipAddress = domain.server?.ipAddress || domain.ipAddress;
    const sshUser = domain.server?.sshUser || domain.sshUser;
    const sshPassword = domain.server?.sshPassword || domain.sshPassword;

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
