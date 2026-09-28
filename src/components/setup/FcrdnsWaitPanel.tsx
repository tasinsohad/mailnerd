import { useMutation } from "@tanstack/react-query";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { recheckFcrdns } from "@/server/domain-setup-fns";
import type { SetupState } from "@/lib/setup-state";

type FcrdnsWaiting = Extract<NonNullable<SetupState["waiting"]>, { kind: "fcrdns" }>;

// Shown while a domain's setup pauses before mailboxes go live: the server's reverse DNS (FCrDNS)
// doesn't pass yet. Mail from an IP whose reverse DNS doesn't match is rejected or spam-foldered, so
// the run won't create mailboxes until the user sets the PTR and re-checks.
export function FcrdnsWaitPanel({
  domainId,
  waiting,
  onChanged,
}: {
  domainId: string;
  waiting: FcrdnsWaiting;
  /** May return a promise (the board's refetch): awaited before the busy state clears. */
  onChanged: () => void | Promise<unknown>;
}) {
  const recheck = useMutation({
    mutationFn: () => recheckFcrdns({ data: { domainId } }),
    onSuccess: (res) => {
      if (res.ok) toast.success("Re-checking reverse DNS…");
      else toast.error(res.error ?? "Couldn't re-check reverse DNS");
      return onChanged();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
      return onChanged();
    },
  });

  return (
    <div
      role="group"
      aria-label="Reverse DNS needs setting"
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 sm:p-4"
    >
      <div className="flex items-start gap-2 text-sm">
        <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 text-foreground">
          <p className="font-medium">
            Reverse DNS (PTR) for <span className="ident">{waiting.ip}</span> isn&apos;t ready
          </p>
          <p className="mt-1 break-words text-muted-foreground">{waiting.message}</p>
          <p className="mt-2 break-words">
            Set the PTR for <span className="ident">{waiting.ip}</span> to{" "}
            <span className="ident break-all">{waiting.expected}</span> in your VPS provider&apos;s
            control panel, then re-check.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-10 flex-1 sm:h-9 sm:flex-none"
          onClick={() => recheck.mutate()}
          disabled={recheck.isPending}
        >
          {recheck.isPending && <Loader2 className="animate-spin" />}
          Re-check and continue
        </Button>
      </div>
    </div>
  );
}
