import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";

// Server functions refuse with UNAUTHENTICATED once the session is gone (it expired, you signed out in another
// tab, your password was reset) and ACCOUNT_LOCKED when the account is pending, suspended or out of plan. Go to
// sign-in or the account status page instead of a page of errors.
function sendToSignInIfSignedOut(error: unknown) {
  if (typeof window === "undefined") return;
  const message = String((error as { message?: unknown })?.message ?? "");
  if (message.includes("ACCOUNT_LOCKED")) {
    if (window.location.pathname !== "/account") window.location.assign("/account");
    return;
  }
  if (!message.includes("UNAUTHENTICATED")) return;
  if (window.location.pathname === "/auth") return;
  const back = window.location.pathname + window.location.search;
  window.location.assign(`/auth?redirect=${encodeURIComponent(back)}`);
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: sendToSignInIfSignedOut }),
        mutationCache: new MutationCache({ onError: sendToSignInIfSignedOut }),
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
