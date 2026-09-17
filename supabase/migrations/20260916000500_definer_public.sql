-- The other half of the door: revoke from PUBLIC, not only from `anon`.
--
-- 20260916000400 revoked these sixteen functions from `anon` and closed
-- THREE of them. `tests/probes/definer_probe.mjs` caught the other thirteen
-- still answering a signed-out caller, which is the only reason this is
-- known — the migration applied cleanly and reported nothing.
--
-- WHY THREE AND NOT SIXTEEN. Every function is born with an implicit EXECUTE
-- grant to PUBLIC, and `anon` is a member of PUBLIC like every other role.
-- Supabase ALSO grants EXECUTE to `anon`, `authenticated` and `service_role`
-- by name, through default privileges on the `public` schema. Those are two
-- separate doors and closing either one alone leaves the other open:
--
--   revoke from anon only    -> still reachable through the PUBLIC grant
--   revoke from public only  -> still reachable through the named grant
--
-- The three that closed — `actor_rank`, `password_is_current`,
-- `session_is_assured` — are exactly the three whose defining migrations
-- already said `revoke all ... from public`. For them 20260916000400 shut the
-- second door and the job was done. The other thirteen had neither, so
-- revoking the named grant changed nothing at all.
--
-- THIS CORRECTS THE LESSON RECORDED IN 20260914000400, which said that
-- `revoke ... from public` "does not cover it" and that revoking from `anon`
-- was the missing piece. True for the client functions, because their own
-- migration had already revoked PUBLIC — but as a general rule it is half the
-- story, and the half that was written down is the half that does not work on
-- a function nobody has touched. **Both statements, always.** The pair below
-- is the form to copy.
--
-- `grant execute ... to authenticated` IS LOAD-BEARING, not decoration.
-- Revoking PUBLIC takes the privilege away from every role that had it only
-- through PUBLIC, and for most of these thirteen that includes the signed-in
-- users the whole app is made of. Without the grant on the next line, every
-- policy calling one of these helpers would refuse its own users and the
-- workspace would go dark. Two controls stand behind that claim: the
-- signed-in half of `definer_probe.mjs` calls all sixteen as a real member,
-- and the live RLS suite makes 379 assertions from real sign-ins through the
-- policies that call them.
--
-- All sixteen are restated here, including the three already shut, so the
-- privileges of every callable `security definer` function in this schema can
-- be read in one place. `revoke` and `grant` are both idempotent.

revoke all on function public.actor_rank()                          from public, anon;
revoke all on function public.can_join_dm(text)                     from public, anon;
revoke all on function public.can_see_attachment(text)              from public, anon;
revoke all on function public.can_see_conversation(text)            from public, anon;
revoke all on function public.can_see_profile(uuid)                 from public, anon;
revoke all on function public.can_see_project(text)                 from public, anon;
revoke all on function public.channel_is_manageable(text)           from public, anon;
revoke all on function public.find_or_create_dm(uuid)               from public, anon;
revoke all on function public.has_permission(text)                  from public, anon;
revoke all on function public.is_attachment_uploader(text)          from public, anon;
revoke all on function public.my_role_id()                          from public, anon;
revoke all on function public.password_is_current()                 from public, anon;
revoke all on function public.project_is_manageable(text)           from public, anon;
revoke all on function public.project_is_viewer_only(text)          from public, anon;
revoke all on function public.session_is_assured()                  from public, anon;
revoke all on function public.user_can_see_project(text, uuid)      from public, anon;

grant execute on function public.actor_rank()                       to authenticated;
grant execute on function public.can_join_dm(text)                  to authenticated;
grant execute on function public.can_see_attachment(text)           to authenticated;
grant execute on function public.can_see_conversation(text)         to authenticated;
grant execute on function public.can_see_profile(uuid)              to authenticated;
grant execute on function public.can_see_project(text)              to authenticated;
grant execute on function public.channel_is_manageable(text)        to authenticated;
grant execute on function public.find_or_create_dm(uuid)            to authenticated;
grant execute on function public.has_permission(text)               to authenticated;
grant execute on function public.is_attachment_uploader(text)       to authenticated;
grant execute on function public.my_role_id()                       to authenticated;
grant execute on function public.password_is_current()              to authenticated;
grant execute on function public.project_is_manageable(text)        to authenticated;
grant execute on function public.project_is_viewer_only(text)       to authenticated;
grant execute on function public.session_is_assured()               to authenticated;
grant execute on function public.user_can_see_project(text, uuid)   to authenticated;
