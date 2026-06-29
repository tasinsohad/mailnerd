import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listServers, createServer, deleteServer } from "@/server/servers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Server, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/servers")({
  component: ServersPage,
});

function ServersPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ label: "", hostname: "", ipAddress: "", sshUser: "root" });

  const { data: serverList = [], isLoading } = useQuery({
    queryKey: ["servers"],
    queryFn: () => listServers(),
  });

  const addMutation = useMutation({
    mutationFn: (data: typeof form) => createServer({ data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servers"] });
      setOpen(false);
      toast.success("Server added!");
    },
    onError: () => toast.error("Failed to add server"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteServer({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servers"] });
      toast.success("Server removed");
    },
    onError: () => toast.error("Failed to delete server"),
  });

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Servers</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your VPS / Mailcow hosts</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 rounded-lg gap-2">
              <Plus className="h-4 w-4" /> Add Server
            </Button>
          </DialogTrigger>
          <DialogContent className="rounded-xl">
            <DialogHeader>
              <DialogTitle>Add New Server</DialogTitle>
            </DialogHeader>
            <form
              className="flex flex-col gap-4 mt-2"
              onSubmit={(e) => {
                e.preventDefault();
                addMutation.mutate(form);
              }}
            >
              <div className="grid gap-2">
                <Label>Label</Label>
                <Input
                  placeholder="e.g. NY-01"
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  required
                  className="rounded-xl"
                />
              </div>
              <div className="grid gap-2">
                <Label>Hostname</Label>
                <Input
                  placeholder="mail.example.com"
                  value={form.hostname}
                  onChange={(e) => setForm((f) => ({ ...f, hostname: e.target.value }))}
                  required
                  className="rounded-xl"
                />
              </div>
              <div className="grid gap-2">
                <Label>IP Address</Label>
                <Input
                  placeholder="1.2.3.4"
                  value={form.ipAddress}
                  onChange={(e) => setForm((f) => ({ ...f, ipAddress: e.target.value }))}
                  required
                  className="rounded-xl"
                />
              </div>
              <div className="grid gap-2">
                <Label>SSH User</Label>
                <Input
                  placeholder="root"
                  value={form.sshUser}
                  onChange={(e) => setForm((f) => ({ ...f, sshUser: e.target.value }))}
                  className="rounded-xl"
                />
              </div>
              <Button
                type="submit"
                disabled={addMutation.isPending}
                className="bg-primary hover:bg-primary/90 rounded-xl mt-2"
              >
                {addMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Add Server"
                )}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : serverList.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-card p-16 text-center ring-1 ring-border">
          <Server className="h-12 w-12 text-muted-foreground" />
          <p className="text-lg font-medium text-foreground">No servers yet</p>
          <p className="text-sm text-muted-foreground">Add your first VPS host to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {serverList.map((s: any) => (
            <div
              key={s.id}
              className="rounded-xl bg-card p-6 ring-1 ring-border shadow-sm flex flex-col gap-3"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <Server className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <div className="font-semibold text-foreground">{s.label}</div>
                    <div className="text-xs text-muted-foreground">{s.hostname}</div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-red-400 hover:text-destructive hover:bg-destructive/10 rounded-xl"
                  onClick={() => deleteMutation.mutate(s.id)}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span className="rounded-lg bg-muted px-2 py-1">{s.ipAddress}</span>
                <span className="rounded-lg bg-muted px-2 py-1">{s.sshUser}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
