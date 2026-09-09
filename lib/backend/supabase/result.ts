/**
 * The two checks every write in this directory makes, in one place.
 *
 * Tasks 5 and 6 each wrote their own copy of `fail` inside `./chat.ts` and
 * `./workspace.ts`, and Task 6 added `requireRows`. Task 7 would have been the
 * third copy, so they moved here instead. The behaviour and the wording are
 * unchanged — the strings below are the ones the existing suites match on.
 *
 * A third check, `refuseAttachments`, lived here from Tasks 5–7 and made every
 * write carrying a file reject outright, because the bytes had nowhere to go.
 * Task 10 gave them somewhere (./storage.ts) and removed it — there is no
 * longer anything to refuse.
 */

/**
 * supabase-js resolves on a database error instead of rejecting, so every call
 * in this directory has to be checked by hand.
 */
export function fail(what: string, error: { message: string; code?: string }): never {
  const code = error.code ? ` [${error.code}]` : "";
  throw new Error(`${what} failed${code}: ${error.message}`);
}

/**
 * The other half of the same rule, for UPDATE and DELETE. PostgREST reports a
 * statement whose USING clause filtered every candidate row away as
 * `error: null` with an empty body — the request was well-formed, it simply
 * matched nothing. That is exactly what "you are not allowed to touch this row"
 * looks like from here, and reading it as success is the false-success class
 * this project has now fixed seven times.
 */
export function requireRows(
  what: string,
  reason: string,
  result: { data: unknown[] | null; error: { message: string; code?: string } | null }
): void {
  if (result.error) fail(what, result.error);
  if (!result.data || result.data.length === 0) {
    throw new Error(`${what} failed: ${reason}`);
  }
}

