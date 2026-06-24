import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listDomains, deleteDomain, listDomainBatches } from "@/server/domains";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Globe, Trash2, Loader2, ChevronRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { AddDomainWizard } from "@/components/AddDomainWizard";

export const Route = createFileRoute("/_app/domains/")({
  component: DomainsPage,
});

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  active: "bg-green-100 text-green-700",
  error: "bg-red-100 text-red-700",
  configuring: "bg-blue-100 text-blue-700",
};

function DomainsPage() {
  const qc = useQueryClient();
  const [batchFilter, setBatchFilter] = useState<string>("all");
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data: batches = [] } = useQuery({
    queryKey: ["domain-batches"],
    queryFn: () => listDomainBatches(),
  });

  const { data: domains = [], isLoading } = useQuery({
    queryKey: ["domains", batchFilter],
    queryFn: () =>
      listDomains({ data: batchFilter !== "all" ? { batchId: batchFilter } : {} }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDomain({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["domains"] });
      toast.success("Domain deleted");
    },
    onError: () => toast.error("Failed to delete domain"),
  });

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Domains</h1>
          <p className="text-sm text-gray-500 mt-1">
            {domains.length} domain{domains.length !== 1 ? "s" : ""} total
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={() => setWizardOpen(true)}
            className="bg-[#4DB584] hover:bg-[#3da070] rounded-2xl gap-2 shadow-lg shadow-[#4DB584]/20"
          >
            <Plus className="h-4 w-4" /> Add Domains
          </Button>

          {batches.length > 0 && (
            <Select value={batchFilter} onValueChange={setBatchFilter}>
              <SelectTrigger className="w-44 rounded-2xl">
                <SelectValue placeholder="All batches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All batches</SelectItem>
                {batches.map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <AddDomainWizard open={wizardOpen} onOpenChange={setWizardOpen} />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : domains.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-3xl bg-white p-16 text-center ring-1 ring-black/5">
          <Globe className="h-12 w-12 text-gray-300" />
          <p className="text-lg font-medium text-gray-700">No domains yet</p>
          <p className="text-sm text-gray-500">Use "Add Domains" to get started.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {domains.map((d: any) => (
            <Link
              key={d.id}
              to="/domains/$id"
              params={{ id: d.id }}
              className="flex items-center justify-between rounded-2xl bg-white px-5 py-4 ring-1 ring-black/5 shadow-sm hover:shadow-md transition-all group"
            >
              <div className="flex items-center gap-4">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50">
                  <Globe className="h-4 w-4 text-blue-500" />
                </div>
                <div>
                  <div className="font-medium text-gray-900">{d.name}</div>
                  <div className="text-xs text-gray-500">
                    {d.plannedInboxCount ? `${d.plannedInboxCount} inboxes planned` : "No plan yet"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-lg px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[d.status] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {d.status}
                </span>
                <div className="rounded-xl p-2 text-gray-400 group-hover:text-[#4DB584]">
                  <ChevronRight className="h-4 w-4" />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-xl text-red-300 hover:text-red-600 hover:bg-red-50"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (confirm(`Delete ${d.name}?`)) deleteMutation.mutate(d.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
