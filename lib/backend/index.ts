/**
 * The backend flag, and the one place a `Backend` is constructed.
 *
 * `NEXT_PUBLIC_BACKEND` is read via `process.env.NEXT_PUBLIC_BACKEND` (not
 * destructured or aliased) so Next.js's build-time inlining can find and
 * replace the exact expression — see the note in .env.example on why that
 * matters for a static export.
 */
import { LocalBackend } from "./local";
import { SupabaseBackend } from "./supabase";
import type { Backend } from "./types";

export type { Backend } from "./types";

export type BackendKind = "local" | "supabase";

function resolveBackendKind(): BackendKind {
  return process.env.NEXT_PUBLIC_BACKEND === "supabase" ? "supabase" : "local";
}

/**
 * `"local"` — today's localStorage-backed store, and the default. This is
 * what the public GitHub Pages build ships until the Phase 3 cutover.
 * `"supabase"` — the real backend, built out across the rest of this plan.
 */
export const backendKind: BackendKind = resolveBackendKind();

/**
 * Builds the backend this build runs against. One instance per
 * `StoreProvider` mount, so per-instance state (`LocalBackend`'s
 * edge-triggered quota flag) has exactly the lifetime the provider's old
 * `useRef` had.
 *
 * The switch reads the module-level `backendKind` above, which is a literal
 * `process.env` comparison so a static export can inline it. Importing
 * `SupabaseBackend` statically is safe: nothing under `lib/backend/supabase/`
 * statically imports `lib/supabase.ts` (see `./supabase/client.ts`), so the
 * module that throws on missing `NEXT_PUBLIC_SUPABASE_*` stays out of the
 * always-loaded graph and the unit suite keeps running without credentials.
 */
export function createBackend(): Backend {
  return backendKind === "supabase" ? new SupabaseBackend() : new LocalBackend();
}
