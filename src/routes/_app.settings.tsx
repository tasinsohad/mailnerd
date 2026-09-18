import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { getSecrets, saveSecrets, verifyCfToken, syncCfZones } from "@/server/secrets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChangePasswordCard } from "@/components/ChangePasswordCard";
import { KeyRound, Cloud, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

type SecretsForm = { cfApiToken?: string; clearCfApiToken?: boolean; cfAccountId?: string };

function SettingsPage() {
  const { account } = Route.useRouteContext();
  const qc = useQueryClient();
  // cfApiToken holds only a NEW token being typed: the saved one never reaches the browser.
  const [form, setForm] = useState({ cfApiToken: "", cfAccountId: "" });
  const [replacingToken, setReplacingToken] = useState(false);
  const [verifyStatus, setVerifyStatus] = useState<{ valid: boolean; error?: string } | null>(null);

  const { data: secrets, isLoading, error, isError } = useQuery({
    queryKey: ["secrets"],
    queryFn: async () => {
      const res = await getSecrets();
      if (res && (res as any).__error) {
        throw new Error((res as any).__error);
      }
      return res || {};
    },
  });

  useEffect(() => {
    if (secrets) {
      setForm((f) => ({ ...f, cfAccountId: secrets.cfAccountId || "" }));
    }
  }, [secrets]);

  const hasSavedToken = Boolean(secrets?.hasCfApiToken);
  // No saved token yet, or the user chose to replace it: show the input.
  const editingToken = !hasSavedToken || replacingToken;

  const closeTokenInput = () => {
    setReplacingToken(false);
    setForm((f) => ({ ...f, cfApiToken: "" }));
    setVerifyStatus(null);
  };

  const saveMutation = useMutation({
    mutationFn: (data: SecretsForm) => saveSecrets({ data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["secrets"] });
      closeTokenInput();
      toast.success("Settings saved successfully");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save settings"),
  });

  const removeTokenMutation = useMutation({
    mutationFn: () => saveSecrets({ data: { clearCfApiToken: true } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["secrets"] });
      closeTokenInput();
      toast.success("Cloudflare API token removed");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove the token"),
  });

  const verifyMutation = useMutation({
    // Without a typed token, the server checks the saved one.
    mutationFn: (token?: string) => verifyCfToken({ data: token ? { token } : {} }),
    onSuccess: (res) => {
      if (!res) {
        toast.error("Verification failed: no response from server");
        return;
      }
      setVerifyStatus(res);
      if (res.valid) toast.success("Token is valid");
      else toast.error(res.error || "Invalid token");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Verification failed"),
  });

  const syncMutation = useMutation({
    mutationFn: () => syncCfZones(),
    onSuccess: (res) => {
      if (!res) {
        toast.error("Sync failed: no response from server");
        return;
      }
      if (res.error) toast.error(res.error);
      else toast.success(`Synced ${res.count} zones`);
    },
  });

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure your API integrations</p>
      </div>

      {account.role !== "admin" && <ChangePasswordCard />}

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : isError ? (
        <div className="rounded-xl bg-destructive/10/50 p-4 sm:p-8 ring-1 ring-red-200/50 flex flex-col gap-5">
          <div>
            <h2 className="text-lg font-semibold text-red-900">Database Connection Failed</h2>
            <p className="text-sm text-destructive/80 leading-relaxed mt-1">
              {error instanceof Error ? error.message : String(error)}
            </p>
          </div>
          <div className="pt-2">
            <Button
              variant="ghost"
              onClick={() => qc.invalidateQueries({ queryKey: ["secrets"] })}
              className="text-destructive hover:text-destructive hover:bg-destructive/15/50 rounded-xl px-4 text-xs"
            >
              Retry Connection
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="rounded-xl bg-card p-4 sm:p-8 shadow-sm ring-1 ring-border flex flex-col gap-6">
            <div className="flex items-center gap-3 border-b border-border pb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#F48120]/10">
                <Cloud className="h-5 w-5 text-[#F48120]" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">Cloudflare Integration</h2>
                <p className="text-xs text-muted-foreground">Required for automated DNS management</p>
              </div>
            </div>

            <form
              className="flex flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                saveMutation.mutate({
                  cfAccountId: form.cfAccountId,
                  // Empty means "keep the saved token"; only a newly typed one replaces it.
                  ...(editingToken && form.cfApiToken ? { cfApiToken: form.cfApiToken } : {}),
                });
              }}
            >
              <div className="grid gap-2">
                <Label className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" /> API Token
                </Label>

                {editingToken ? (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      placeholder={
                        hasSavedToken
                          ? "New Cloudflare API token"
                          : "Cloudflare API Token with DNS Edit permissions"
                      }
                      value={form.cfApiToken}
                      onChange={(e) => setForm((f) => ({ ...f, cfApiToken: e.target.value }))}
                      className="rounded-xl font-mono flex-1 min-w-0 basis-48"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => verifyMutation.mutate(form.cfApiToken)}
                      disabled={verifyMutation.isPending || !form.cfApiToken}
                      className="rounded-xl border-border"
                    >
                      {verifyMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Verify"
                      )}
                    </Button>
                    {hasSavedToken && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={closeTokenInput}
                        className="rounded-xl"
                      >
                        Keep saved token
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex-1 min-w-0 basis-48 truncate rounded-xl border border-border bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
                      Saved{secrets?.cfApiTokenHint ? ` (…${secrets.cfApiTokenHint})` : ""}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => verifyMutation.mutate(undefined)}
                      disabled={verifyMutation.isPending}
                      className="rounded-xl border-border"
                    >
                      {verifyMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Verify"
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setReplacingToken(true);
                        setVerifyStatus(null);
                      }}
                      className="rounded-xl border-border"
                    >
                      Enter new token
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        if (
                          window.confirm(
                            "Remove the saved Cloudflare API token? DNS changes stop working until you add one again.",
                          )
                        ) {
                          removeTokenMutation.mutate();
                        }
                      }}
                      disabled={removeTokenMutation.isPending}
                      className="rounded-xl text-destructive hover:text-destructive"
                    >
                      Remove
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  {verifyStatus && (
                    <span
                      className={`max-w-full break-words text-[10px] font-bold px-2 py-0.5 rounded-md ${verifyStatus.valid ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
                    >
                      {verifyStatus.valid ? "✅ VALID" : `❌ INVALID: ${verifyStatus.error}`}
                    </span>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Must have Zone:Read and DNS:Edit permissions.
                  </p>
                </div>
              </div>

              <div className="grid gap-2">
                <Label className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" /> Account ID
                </Label>
                <Input
                  placeholder="Cloudflare Account ID (optional)"
                  value={form.cfAccountId}
                  onChange={(e) => setForm((f) => ({ ...f, cfAccountId: e.target.value }))}
                  className="rounded-xl font-mono"
                />
              </div>

              <div className="pt-2 flex flex-wrap gap-2 sm:gap-3">
                <Button
                  type="submit"
                  disabled={saveMutation.isPending}
                  className="bg-primary hover:bg-primary/90 rounded-xl w-full sm:w-32"
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Save Changes"
                  )}
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending || !secrets?.hasCfApiToken}
                  className="rounded-xl border-border gap-2 w-full sm:w-auto"
                >
                  {syncMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Cloud className="h-4 w-4" />
                  )}
                  Sync Zones
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
