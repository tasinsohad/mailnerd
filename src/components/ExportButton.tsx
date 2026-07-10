import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { EXPORT_FORMATS } from "@/lib/export-formats";

// A standalone "Export CSV" button that opens a platform picker. Every option calls
// onExport(formatId); the caller builds + downloads the CSV via buildExportCsv. Used wherever a
// bare export button lives (domain detail, domains list "download all", job export). Inside an
// existing dropdown, map EXPORT_FORMATS to sub-items instead of using this.
export function ExportButton({
  label = "Export CSV",
  disabled = false,
  busy = false,
  title,
  onExport,
  align = "end",
  className = "gap-2",
  variant = "outline",
}: {
  label?: string;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  onExport: (formatId: string) => void;
  align?: "start" | "center" | "end";
  className?: string;
  variant?: "outline" | "default" | "ghost" | "secondary";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} disabled={disabled || busy} title={title} className={className}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-52">
        <DropdownMenuLabel>Export for…</DropdownMenuLabel>
        {EXPORT_FORMATS.map((f) => (
          <DropdownMenuItem key={f.id} onClick={() => onExport(f.id)}>
            {f.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
