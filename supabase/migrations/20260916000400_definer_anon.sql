-- Shut the remaining `security definer` helpers to signed-out callers.
--
-- 20260914000400 closed the four client-record functions and said, in as many
-- words, that every other `security definer` function in this schema still had
-- the loose form and deserved its own change and its own probe run. This is
-- that change. `tests/probes/definer_probe.mjs` is that probe.
--
-- THE TRAP, restated because it is the whole reason this was missed. Supabase
-- ships default privileges on the `public` schema that grant EXECUTE on every
-- new function to `anon`, `authenticated` and `service_role` BY NAME.
-- `revoke all on function ... from public` removes only the implicit grant a
-- function is born with — it does not touch an explicit grant to a named role.
-- So the familiar pair,
--
--     revoke all on function f() from public;
--     grant execute on function f() to authenticated;
--
-- reads like a closed door and is not one. Sixteen functions here had it.
--
-- WHAT THIS DOES AND DOES NOT FIX. It is not a leak. Every one of these
-- refuses an anonymous caller on its own merits, all 111 policies in this
-- schema are `to authenticated`, and the probe confirms no client data comes
-- back. What it fixes is that the defence lived in ONE place: the order of
-- statements inside a function body. `security definer` means the body runs
-- with the OWNER's privileges and does not consult RLS, so an edit that
-- reordered a guard would turn an open door into an open vault, and nothing
-- outside that one file would notice. EXECUTE is the door; the body is the
-- bouncer. Keep both.
--
-- WHAT THE PROBE FOUND ON THE WAY IN, worth recording because it is the
-- sharpest argument for the door. Called by an anonymous client BEFORE this
-- migration, the two sign-in gates both answered `true`:
--
--     session_is_assured()  -> true
--     password_is_current() -> true
--
-- Not a bug in either: both are `not exists (... where user_id = auth.uid())`,
-- and for a null uid that is vacuously true. They fail OPEN for a caller who
-- is nobody. This costs nothing today because the gates are restrictive
-- policies `to authenticated`, which `anon` never evaluates — but a single
-- future policy written `to public` would inherit an open gate rather than a
-- shut one. `can_see_conversation('c_general')` likewise answered `true` to a
-- signed-out caller, which is a conversation-existence oracle and nothing
-- more. Hardening those BODIES to demand a non-null `auth.uid()` is a real
-- improvement and a behaviour change to the gate path; it is deliberately not
-- folded in here, where the whole point is that the change is provably
-- privilege-only.
--
-- `authenticated` is untouched throughout: each statement names `anon` alone,
-- so every existing `grant execute ... to authenticated` stands. The control
-- for that claim is the live RLS suite — 379 assertions made from real
-- sign-ins, which exercise these helpers through every policy that calls
-- them — plus the signed-in half of the probe.

revoke all on function public.actor_rank() from anon;
revoke all on function public.can_join_dm(text) from anon;
revoke all on function public.can_see_attachment(text) from anon;
revoke all on function public.can_see_conversation(text) from anon;
revoke all on function public.can_see_profile(uuid) from anon;
revoke all on function public.can_see_project(text) from anon;
revoke all on function public.channel_is_manageable(text) from anon;
revoke all on function public.find_or_create_dm(uuid) from anon;
revoke all on function public.has_permission(text) from anon;
revoke all on function public.is_attachment_uploader(text) from anon;
revoke all on function public.my_role_id() from anon;
revoke all on function public.password_is_current() from anon;
revoke all on function public.project_is_manageable(text) from anon;
revoke all on function public.project_is_viewer_only(text) from anon;
revoke all on function public.session_is_assured() from anon;
revoke all on function public.user_can_see_project(text, uuid) from anon;

-- DELIBERATELY LEFT OPEN: `public.dm_pair_key(uuid, uuid)`.
--
-- It is `security invoker` and `immutable` — a pure function of the two uuids
-- the caller already holds, touching no table and consulting no session. There
-- is nothing behind that door to shut. It stays open on purpose as the probe's
-- can-fail control: if every function in the schema refused an anonymous
-- caller, a refusal would prove nothing about privileges, and the probe would
-- pass on silence. Closing it later means giving the probe a new control
-- first, not deleting the check.
