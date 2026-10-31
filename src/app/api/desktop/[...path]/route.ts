import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { handleDesktopRequest } from "@/lib/desktop/api";

// The KELQOR desktop app's interface to this backend (see src/lib/desktop/api.ts). Local development only.
export const dynamic = "force-dynamic";

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const res = await handleDesktopRequest(getDb, { method: request.method, path, headers: request.headers, json: () => request.json() });
  return NextResponse.json(res.body, { status: res.status, headers: { "Cache-Control": "no-store" } });
}

export { handle as DELETE, handle as GET, handle as POST, handle as PUT };
