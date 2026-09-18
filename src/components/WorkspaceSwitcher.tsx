import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listWorkspaces, setWorkspace } from "@/server/admin-users";

// Admin only: pick whose workspace the app shows. Switching reloads the app so no cached data from the
// previous workspace survives.
export function WorkspaceSwitcher({ currentId }: { currentId: string }) {
  const { data: workspaces = [] } = useQuery({ queryKey: ["workspaces"], queryFn: () => listWorkspaces() });
  const [switching, setSwitching] = useState(false);

  const change = async (id: string) => {
    if (id === currentId) return;
    setSwitching(true);
    try {
      const result = await setWorkspace({ data: { userId: id } });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't open that workspace.");
        setSwitching(false);
        return;
      }
      window.location.assign("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open that workspace.");
      setSwitching(false);
    }
  };

  return (
    <div className="px-3 pb-2">
      <div className="ident mb-1 px-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Workspace</div>
      <Select value={currentId} onValueChange={change} disabled={switching}>
        <SelectTrigger className="h-10 w-full">
          <SelectValue placeholder="Workspace" />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.name}
              {w.role === "admin" ? " (you)" : w.state !== "active" ? ` (${w.state})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
