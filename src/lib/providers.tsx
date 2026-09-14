import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";

// Server functions refuse with an UNAUTHENTICATED error once the session is gone (it expired, you
// signed out in another tab, or ADMIN_PASSWORD changed). Go to sign-in instead of a page of errors.
function sendToSignInIfSignedOut(error: unknown) {
  if (typeof window === "undefined") return;
  if (!String((error as { message?: unknown })?.message ?? "").includes("UNAUTHENTICATED")) return;
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
