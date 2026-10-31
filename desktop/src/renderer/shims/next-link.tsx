import type { ReactNode } from "react";

// Stand-in for next/link, so the web app's shared UI primitives (src/components/ui.tsx) render in the desktop app.
// The desktop app navigates through its own views, so a shared link renders as plain text and never navigates.
export default function Link({ children, className }: { href: string; children: ReactNode; className?: string }) {
  return <span className={className}>{children}</span>;
}
