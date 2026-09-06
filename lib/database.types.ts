/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with `npm run db:types`, which runs
 * `supabase gen types typescript --linked` against the lumina-dev project.
 *
 * This placeholder stands in until the first migration is pushed; it keeps
 * `lib/supabase.ts` and the test helpers type-checking against an empty
 * schema rather than failing to resolve.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
