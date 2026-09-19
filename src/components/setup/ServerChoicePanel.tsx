import { useMutation } from "@tanstack/react-query";
import { Loader2, ServerCog } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { decideServerChoice } from "@/server/domain-setup-fns";
import type { ServerChoice, SetupState } from "@/lib/setup-state";

// Shown while a domain's setup waits for the user: its server already runs Mailcow. Keeping it adds this
// domain to that Mailcow; reinstalling wipes the server, every domain on it included, so it asks first.
export function ServerChoicePanel({
  domainId,
  waiting,
  onChanged,
}: {
  domainId: string;
  waiting: NonNullable<SetupState["waiting"]>;
  /** May return a promise (e.g. the board's invalidate/refetch): awaited before the busy state clears, so
   * the choice buttons stay disabled until the fresh row lands instead of flashing back to their old state. */
  onChanged: () => void | Promise<unknown>;
}) {
  const decide = useMutation({
    mutationFn: (choice: ServerChoice) => decideServerChoice({ data: { domainId, choice } }),
    onSuccess: (res, choice) => {
      if (res.ok) {
        toast.success(
          choice === "reuse"
            ? "Adding this domain to the existing Mailcow"
            : "Reinstalling Mailcow on this server",
        );
      } else {
        toast.error(res.error ?? "Couldn't save your choice");
      }
      return onChanged();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
      return onChanged();
    },
  });

  const reinstall = () => {
    if (confirm(`This deletes every mailbox on ${waiting.ip}, for every domain on that server. Continue?`)) {
      decide.mutate("reinstall");
    }
  };

  const others = waiting.otherDomains.length ? waiting.otherDomains.join(", ") : "none in this app";
  const pendingChoice = decide.isPending ? decide.variables : null;

  return (
    <div
      role="group"
      aria-label="Choose what to do with this server"
      className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 sm:p-4"
    >
      <div className="flex items-start gap-2 text-sm">
        <ServerCog aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p className="min-w-0 break-words text-foreground">
          Server <span className="ident">{waiting.ip}</span> already runs Mailcow
          {waiting.hostname ? (
            <>
              {" "}
              as <span className="ident break-all">{waiting.hostname}</span>
            </>
          ) : null}
          . Other domains using it: {others}.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-10 flex-1 sm:h-9 sm:flex-none"
          onClick={() => decide.mutate("reuse")}
          disabled={decide.isPending}
        >
          {pendingChoice === "reuse" && <Loader2 className="animate-spin" />}
          Add to existing Mailcow
        </Button>
        <Button
          variant="outline"
          className="h-10 flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-9 sm:flex-none"
          onClick={reinstall}
          disabled={decide.isPending}
        >
          {pendingChoice === "reinstall" && <Loader2 className="animate-spin" />}
          Wipe &amp; reinstall
        </Button>
      </div>
    </div>
  );
}
