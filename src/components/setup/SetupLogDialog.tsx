import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Connection = "connecting" | "live" | "ended";

// The dot's color: red or green once the stream reports the end, grey when disconnected, amber while live.
function statusTone(status: string | null, connection: Connection): string {
  if (status === "Failed") return "text-destructive";
  if (status === "Ready") return "text-success";
  if (connection === "ended") return "text-muted-foreground";
  return "text-warning";
}

// A domain's setup terminal: the log saved so far, then new output as it arrives (/api/sse?domainId=). The
// stream is open only while the dialog is: closing it (or unmounting) closes the stream.
export function SetupLogDialog({
  domainId,
  domainName,
  ipAddress,
  open,
  onOpenChange,
}: {
  domainId: string;
  domainName: string;
  ipAddress: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  // Bumped by Reconnect to open a fresh stream.
  const [attempt, setAttempt] = useState(0);
  // The scrollable log pane itself: auto-scroll moves only this box, never the page.
  const logPaneRef = useRef<HTMLDivElement>(null);
  // Follow new output only while the reader is at the bottom; scrolling up to read pauses it.
  const followRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    setLogs([]);
    setStatus(null);
    setConnection("connecting");
    followRef.current = true;

    const eventSource = new EventSource(`/api/sse?domainId=${encodeURIComponent(domainId)}`);
    eventSource.onopen = () => setConnection("live");
    eventSource.onmessage = (event) => {
      let parsed: { status?: string; chunk?: string; msg?: string };
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      setConnection("live");
      if (parsed.status) setStatus(parsed.status);
      const chunk = parsed.chunk;
      if (chunk) {
        setLogs((prev) => {
          // The saved log is resent in full on connect: replace what we have when it extends it.
          if (prev.length > 0 && chunk.startsWith(prev.join(""))) return [chunk];
          if (prev.includes(chunk)) return prev;
          return [...prev, chunk];
        });
      } else if (parsed.msg) {
        const systemMsg = `[System] ${parsed.msg}\n`;
        setLogs((prev) => (prev.includes(systemMsg) ? prev : [...prev, systemMsg]));
      }
    };
    // Don't let the browser retry on its own (a refused or signed-out stream would loop): Reconnect does it.
    eventSource.onerror = () => {
      eventSource.close();
      setConnection("ended");
    };
    return () => eventSource.close();
  }, [open, domainId, attempt]);

  useEffect(() => {
    const el = logPaneRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const onLogScroll = () => {
    const el = logPaneRef.current;
    if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  };

  // The stream sends "provisioning"/"configuring" on connect, then labels like "Pulling Images", and ends on
  // "Ready" or "Failed".
  const finished = status === "Ready" || status === "Failed";
  const statusLabel =
    connection === "ended" && !finished
      ? "Disconnected"
      : status
        ? status.charAt(0).toUpperCase() + status.slice(1)
        : connection === "connecting"
          ? "Connecting…"
          : "Live";
  const pulsing = connection === "live" && !finished;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-3 p-4 sm:p-6">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>Setup log</DialogTitle>
          <DialogDescription className="ident break-all">
            {domainName}
            {ipAddress ? ` · ${ipAddress}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <span className="inline-flex items-center gap-2 text-foreground" aria-live="polite">
            <span
              className={cn("status-dot", statusTone(status, connection), pulsing && "status-dot--pulse")}
            />
            {statusLabel}
          </span>
          {connection === "ended" && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-9 gap-1.5"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RefreshCw /> Reconnect
            </Button>
          )}
        </div>

        <div
          ref={logPaneRef}
          onScroll={onLogScroll}
          className="console h-[60dvh] overflow-y-auto p-3 text-xs sm:h-96 sm:p-4"
        >
          {logs.length ? (
            <pre className="whitespace-pre-wrap break-all font-[inherit]">{logs.join("")}</pre>
          ) : (
            <p className="text-white/50">
              {connection === "ended" ? "No log output." : "Waiting for log output…"}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
