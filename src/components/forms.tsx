"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/actions";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const PendingContext = createContext<boolean | null>(null);

/**
 * A form bound to a server action, showing its error or success message inline.
 * Submissions are dispatched manually so React does not clear the fields when the server rejects
 * the input (React 19 resets uncontrolled forms after a form action). Without JavaScript the
 * `action` attribute still submits the form natively.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  confirmText,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  confirmText?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    if (confirmText && !window.confirm(confirmText)) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const data = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(data));
  }

  return (
    <PendingContext.Provider value={pending}>
      <form ref={ref} action={formAction} onSubmit={onSubmit} className={className}>
        {children}
        {state?.error ? (
          <p role="alert" className="mt-2 text-sm font-medium text-rose-700">
            {state.error}
          </p>
        ) : null}
        {state?.ok && state.message ? (
          <p role="status" className="mt-2 text-sm text-emerald-700">
            {state.message}
          </p>
        ) : null}
      </form>
    </PendingContext.Provider>
  );
}

export function SubmitButton({
  children,
  variant = "primary",
  pendingText = "Working…",
  className = "",
  name,
  value,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  pendingText?: string;
  className?: string;
  name?: string;
  value?: string;
}) {
  const formStatus = useFormStatus();
  const contextPending = useContext(PendingContext);
  const pending = contextPending ?? formStatus.pending;
  return (
    <button type="submit" name={name} value={value} disabled={pending} className={`fx-btn fx-btn-${variant} ${className}`}>
      {pending ? pendingText : children}
    </button>
  );
}
