-- Shut the client-record functions to signed-out callers at the door.
--
-- FOUND BY tests/probes/client_probe.mjs, not by reading the code. The probe
-- asks an anonymous client to reveal a password and expects a refusal. It got
-- one - but the refusal was `You must be signed in to do that`, which is a
-- sentence from INSIDE `assert_client_editor`. That means the anonymous role
-- executed the function body.
--
-- WHY `revoke all ... from public` did not cover it. Supabase ships default
-- privileges on the `public` schema that grant EXECUTE on new functions to
-- `anon`, `authenticated` and `service_role` by name. Revoking from PUBLIC
-- removes the implicit grant every function is born with; it does not touch an
-- explicit grant to a named role. `grant execute ... to authenticated` then
-- looks like the complete story and is not.
--
-- WAS ANYTHING EXPOSED? No. `auth.uid()` is null for an anonymous session, so
-- the first line of `assert_client_editor` refused it, and the probe's other
-- checks confirm no client data came back. This is defence in depth rather
-- than a fix for a leak - but the defence is worth having precisely because it
-- does not depend on the first line of a function body staying where it is. A
-- later edit that reordered those checks would turn a closed door into an open
-- one, and nothing outside this migration would notice.
--
-- The same is true of every `security definer` function in this schema
-- (`find_or_create_dm`, `create_project_with_tasks`, `has_permission`, ...).
-- They are left alone here on purpose: this migration belongs to the Client
-- Info work, and sweeping the rest is a separate change that deserves its own
-- reasoning and its own probe run. The finding is recorded in
-- docs/runbooks/client-info.md so it is not lost.
revoke all on function public.assert_client_editor(text) from anon;
revoke all on function public.set_client_password(text, text) from anon;
revoke all on function public.reveal_client_password(text) from anon;

-- `client_secret_ids` already revokes from anon by name (20260914000300).
-- Restated here so the three client functions can be checked in one place.
revoke all on function public.client_secret_ids() from anon;
