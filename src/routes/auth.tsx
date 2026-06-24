import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
});

// In development, auth is handled server-side with auto-login
// Redirect to home page
function AuthPage() {
  return <Navigate to="/" />;
}
