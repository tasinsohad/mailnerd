import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Copy, Check, Download } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv";
import {
  buildSubdomainCsv,
  subdomainListText,
  type SubdomainRow,
} from "@/lib/subdomains";

// Shows the unique subdomains for a domain or job with two ways out: copy the plain list, or
// download a `domain,subdomain` CSV. Rows are already deduped/apex-excluded by the caller.
export function ExportSubdomainsDialog({
  open,
  onOpenChange,
  rows,
  filenameBase,
  title = "Export subdomains",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: SubdomainRow[];
  filenameBase: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = subdomainListText(rows);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`Copied ${rows.length} subdomain${rows.length === 1 ? "" : "s"}`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };

  const download = () => {
    downloadCsv(`${filenameBase}_subdomains.csv`, buildSubdomainCsv(rows));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {title}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {rows.length} subdomain{rows.length === 1 ? "" : "s"}
            </span>
          </DialogTitle>
        </DialogHeader>

        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No subdomains to export yet. Plan the domain's inboxes first.
          </p>
        ) : (
          <>
            <Textarea
              readOnly
              value={text}
              onFocus={(e) => e.currentTarget.select()}
              className="min-h-[220px] resize-none font-mono text-xs leading-relaxed"
            />
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={copy} className="gap-2">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button onClick={download} className="gap-2">
                <Download className="h-4 w-4" />
                Download CSV
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
