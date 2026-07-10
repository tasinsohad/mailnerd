// Client-only CSV download helper. The actual CSV *content* is built by the platform-aware
// registry in `export-formats.ts` (buildExportCsv) — this file just triggers the browser save so
// the format logic stays DOM-free and testable.

// Trigger a browser download of CSV text. Client-only.
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
