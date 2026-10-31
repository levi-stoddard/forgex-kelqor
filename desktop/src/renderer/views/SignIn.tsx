import { LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Alert, Field } from "@/components/ui";
import type { AppStatus } from "../../shared/bridge";
import { BackendBanner, BackendPill, Logo } from "../components";
import { kelqor } from "../lib";

export function SignInView({ status }: { status: AppStatus }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = status.backend.state === "connected";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await kelqor().signIn(email, password);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else setPassword("");
  }

  return (
    <div className="flex h-full items-center justify-center bg-stone-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={40} />
          <div>
            <div className="text-xl font-bold tracking-wide text-stone-900">KELQOR</div>
            <div className="text-sm text-stone-500">Command Center</div>
          </div>
        </div>
        <form onSubmit={submit} className="fx-card space-y-4 px-5 py-5" data-testid="sign-in">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-semibold text-stone-900">Sign in</h1>
            <BackendPill backend={status.backend} starting={status.localBackend.state === "starting"} />
          </div>
          <Field label="Email" htmlFor="email">
            <input id="email" type="email" autoComplete="username" className="fx-input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password" htmlFor="password">
            <input id="password" type="password" autoComplete="current-password" className="fx-input" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error ? <Alert tone="rose">{error}</Alert> : null}
          {!online ? <BackendBanner status={status} /> : null}
          <button type="submit" className="fx-btn fx-btn-primary w-full" disabled={busy || !online}>
            <LogIn size={15} /> {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="text-xs text-stone-500">
            Use your operator account from the local backend. This release is for the owner; team and customer access come later.
          </p>
        </form>
      </div>
    </div>
  );
}
