export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#1c1917" />
      <path d="M9.5 9.5l13 13" stroke="#fafaf9" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M22.5 9.5l-13 13" stroke="#f97316" strokeWidth="3.4" strokeLinecap="round" />
      <circle cx="23.2" cy="8.8" r="2.3" fill="#fdba74" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark />
      <span className="text-lg font-bold tracking-tight text-stone-900">
        Forge<span className="text-ember-600">X</span>
      </span>
    </span>
  );
}
