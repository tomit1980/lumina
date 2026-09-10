-- QA-117 — a new teammate, and every role change, never reached an open tab.
--
-- 20260909001100_realtime.sql published twelve tables. `profiles` and `roles`
-- were not among them, and nothing else generates an event for either:
-- `setUserRole` writes profiles; `setRolePermission`, `updateRole`,
-- `createRole` and `deleteRole` write roles. None of them touches a published
-- table, so a browser that was already open never heard about any of it.
--
-- CONFIRMED against lumina-dev rather than inferred from the file above, with
-- a control on the same socket so that "heard nothing" could be told apart
-- from "heard nothing about profiles":
--
--     control  read_state events: 1
--     subject  profiles   events: 0
--
-- What that cost, in the order it bites:
--
--   * A person added to the workspace never appeared in the sidebar, the
--     People page, the DM picker, the assignee list or the access dialogs
--     until the tab was reloaded by hand — and their first message arrived
--     carrying an author_id nobody could resolve, which is the routine
--     trigger for QA-116. That one is fixed in the client (an unknown author
--     renders as "Someone" instead of as a real colleague), but rendering the
--     right name needs the profile to actually arrive, which is this.
--   * A role rename, a colour change, and a permission granted or revoked all
--     failed to land anywhere but the admin's own screen. Enforcement was
--     never affected — RLS and the triggers refuse the write regardless — so
--     the damage was a UI that kept offering buttons that had started failing,
--     and an admin with no way to see that their revocation had not shown up.
--
-- No client change goes with this: both tables are already read by
-- `hydrate.ts`, and `toRealtimeEvent` maps anything that is not a `messages`
-- INSERT to `{ kind: "stale" }`, which is exactly the coalesced reload these
-- need. Adding them to the publication is the whole fix.
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.roles;

-- Same reason the twelve tables before them carry it: without full replica
-- identity a DELETE arrives with the primary key alone. For `roles` that is
-- the difference between "this role is gone" and an event the client cannot
-- match to anything it holds. `profiles` deletion is driven by auth anyway,
-- but the two behave the same way here for the same reason.
alter table public.profiles replica identity full;
alter table public.roles replica identity full;
