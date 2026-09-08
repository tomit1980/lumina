/**
 * The backend flag. `lib/store.tsx` doesn't consume this yet — Task 1 wires
 * a `Backend` interface (`LocalBackend` / `SupabaseBackend`) behind it. This
 * file only decides, once, which one a given build is for.
 *
 * `NEXT_PUBLIC_BACKEND` is read via `process.env.NEXT_PUBLIC_BACKEND` (not
 * destructured or aliased) so Next.js's build-time inlining can find and
 * replace the exact expression — see the note in .env.example on why that
 * matters for a static export.
 */
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
