import { LinkButton } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      <p className="text-sm font-semibold text-ember-700">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">We couldn't find that page</h1>
      <p className="mt-2 text-sm text-stone-600">It may have moved, or you may not have access to it.</p>
      <div className="mt-6">
        <LinkButton href="/">Go home</LinkButton>
      </div>
    </div>
  );
}
