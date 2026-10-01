import type { ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

const DEMO_LOG: { t: string; kind?: "ok" | "warn" | "err"; m: string }[] = [
  { t: "14:02:11", m: "Connecting to 203.0.113.24:22" },
  { t: "14:02:13", kind: "ok", m: "SSH connected as root" },
  { t: "14:02:41", m: "Docker 27.3 already installed" },
  { t: "14:03:02", m: "Pulling mailcow/dovecot:2.3" },
  { t: "14:03:40", kind: "warn", m: "Retry 1/3: registry timeout on mailcow/rspamd" },
  { t: "14:04:05", kind: "ok", m: "mailcow/rspamd pulled" },
  { t: "14:04:32", m: "Generating config for mail.example.com" },
  { t: "14:05:18", kind: "ok", m: "DKIM key published, domain ready" },
];

const LOG_TONE = { ok: "text-[#6fd3a4]", warn: "text-[#e9b752]", err: "text-[#f59582]" } as const;

/* Sign-in, sign-up and the account status page: form on the left, and on wide screens a
   static picture of what the product does — a provisioning log — on the right. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-background font-sans text-foreground lg:grid-cols-2">
      <div className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <BrandMark />
            <span className="font-display text-[15px] font-semibold tracking-tight">Mail Nerd</span>
            <ThemeToggle className="ml-auto" />
          </div>
          {children}
        </div>
      </div>
      <div className="hidden items-center border-l border-border bg-secondary/60 px-[8%] lg:flex" aria-hidden>
        <div className="console w-full overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#2a2c26] bg-white/[0.025] px-3 py-2 text-xs text-[#8d9084]">
            <span>job: provisioning 20 domains</span>
            <span>3 of 5</span>
          </div>
          <div className="flex flex-col px-3 py-2.5">
            {DEMO_LOG.map((l) => (
              <div key={l.t} className="grid grid-cols-[64px_1fr] gap-3">
                <span className="text-[#8d9084]">{l.t}</span>
                <span className={l.kind ? LOG_TONE[l.kind] : undefined}>{l.m}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
