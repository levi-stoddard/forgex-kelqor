import { eq } from "drizzle-orm";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { logoutAction } from "@/app/actions/auth";
import { Logo } from "@/components/logo";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { customerServices } from "@/lib/db/schema";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ForgeX: fixed-price automation, accepted before it's paid", template: "%s · ForgeX" },
  description:
    "ForgeX scopes AI and workflow automation for growing service businesses, quotes a fixed price, and pays vetted builders only when you accept the work.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#fafaf9" };

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="rounded-md px-2.5 py-1.5 text-stone-700 hover:bg-stone-100 hover:text-stone-900">
      {children}
    </Link>
  );
}

/** A customer with a managed service (Milestone 4) is led to its services, not to the older marketplace pages. */
async function hasManagedServices(user: SessionUser): Promise<boolean> {
  if (user.role !== "client" || !user.orgId) return false;
  const db = await getDb();
  const [row] = await db.select({ id: customerServices.id }).from(customerServices).where(eq(customerServices.orgId, user.orgId)).limit(1);
  return Boolean(row);
}

function RoleNav({ user, managed }: { user: SessionUser; managed: boolean }) {
  if (user.role === "operator") {
    return (
      <>
        <NavLink href="/dashboard">Pipeline</NavLink>
        <NavLink href="/ops/new">New Work Order</NavLink>
        <NavLink href="/ops/builders">Builders</NavLink>
        <NavLink href="/ops/outbox">Outbox</NavLink>
      </>
    );
  }
  if (user.role === "builder") {
    return (
      <>
        <NavLink href="/dashboard">Dashboard</NavLink>
        <NavLink href="/profile">Profile</NavLink>
        {user.builderStatus === "approved" && user.builderSlug ? <NavLink href={`/b/${user.builderSlug}`}>Public record</NavLink> : null}
      </>
    );
  }
  if (managed) {
    return (
      <>
        <NavLink href="/services">Services</NavLink>
        <NavLink href="/services/new">New request</NavLink>
      </>
    );
  }
  return (
    <>
      <NavLink href="/dashboard">HQ</NavLink>
      <NavLink href="/services">Services</NavLink>
      <NavLink href="/orders/new">New request</NavLink>
    </>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  const managed = user ? await hasManagedServices(user) : false;
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 border-b border-stone-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <Link href={managed ? "/services" : user ? "/dashboard" : "/"} aria-label="ForgeX home">
              <Logo />
            </Link>
            <nav className="flex flex-wrap items-center gap-1 text-sm">
              {user ? (
                <>
                  <RoleNav user={user} managed={managed} />
                  <span className="hidden px-2 text-stone-400 sm:inline" aria-hidden="true">
                    |
                  </span>
                  <span className="hidden max-w-40 truncate px-1 text-stone-500 md:inline" title={user.email}>
                    {user.name}
                  </span>
                  <form action={logoutAction}>
                    <button type="submit" className="rounded-md px-2.5 py-1.5 text-stone-700 hover:bg-stone-100">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <NavLink href="/home-services">Home services</NavLink>
                  <NavLink href="/outcomes">Outcomes</NavLink>
                  <NavLink href="/builders">For builders</NavLink>
                  <NavLink href="/login">Sign in</NavLink>
                  <Link href="/signup" className="fx-btn fx-btn-primary ml-1 px-3 py-1.5">
                    Start a request
                  </Link>
                </>
              )}
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-stone-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-stone-500 sm:flex-row sm:items-center sm:justify-between">
            <p>ForgeX is a working name. Pre-launch MVP: terms are drafts pending legal review.</p>
            <div className="flex flex-wrap gap-4">
              <Link href="/home-services" className="hover:text-stone-800">
                Home services
              </Link>
              <Link href="/outcomes" className="hover:text-stone-800">
                Outcomes
              </Link>
              <Link href="/builders" className="hover:text-stone-800">
                For builders
              </Link>
              <Link href="/terms" className="hover:text-stone-800">
                Work Order terms (draft)
              </Link>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
