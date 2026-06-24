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

    if (!domain || !domain.server) return { success: false, error: "Domain or Server not found" };

    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: domain.server.ipAddress,
        username: domain.server.sshUser,
        password: domain.server.sshPassword || undefined,
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

    const domain = await db.query.domains.findFirst({
      where: and(eq(domains.id, data.domainId), eq(domains.userId, userId)),
      with: { server: true },
    });

    if (!domain || !domain.server) return { error: "Domain or Server not found" };

    try {
      // Enqueue job via BullMQ
      const job = await addServerSetupJob(
        domain.id,
        domain.server.ipAddress,
        domain.server.sshUser,
        domain.server.sshPassword,
        domain.name,
      );

      await db.update(domains).set({ status: "provisioning" }).where(eq(domains.id, domain.id));

      return { success: true, jobId: job.jobId };
    } catch (error) {
      await db.update(domains).set({ status: "error" }).where(eq(domains.id, domain.id));
      return { success: false, error: String(error) };
    }
  });
