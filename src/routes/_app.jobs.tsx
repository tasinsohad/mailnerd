import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/jobs")({
  component: () => <Outlet />,
});
