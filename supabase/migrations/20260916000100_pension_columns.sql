-- The six pension columns.
--
-- Columns are rows in `statuses`, seeded once by 20260910005000 with
-- `on conflict do nothing`. So this is a data migration: it must move work
-- before it removes a column, because `tasks.status` references `statuses`
-- with `on delete restrict`. Idempotent — every statement is a no-op the
-- second time.
--
-- ANY TASK IN BACKLOG MOVES TO TO DO. Agreed with the owner on 2026-09-16.
-- Names of the four surviving columns are not touched: a rename made in
-- Settings must not be undone by a redeploy (20260910005000's rule).
--
-- A WORKSPACE THAT ADDED ITS OWN COLUMN IS A DIFFERENT CASE FROM A RENAME.
-- `createStatus` (lib/store.tsx) appends a custom column at
-- `max(position) + 1`, so on a five-column workspace one lands at position
-- 5 — exactly where `done` used to sit and where this migration now pins
-- `done` again. Pinning the six known ids to 0–5 outright would leave that
-- custom column's own position untouched and colliding with whichever known
-- id it used to share a slot with. So the six known ids take 0–5, and
-- everything else — every id this migration does not itself name — is
-- renumbered to start at 6, in the order those columns already had among
-- themselves. A workspace with no custom columns renumbers nothing.
insert into public.statuses (id, name, color, position, is_done) values
  ('pending-payout',  'Pending Payout (From Super)',   '#14b8a6', 3, false),
  ('pending-payment', 'Pending Payment (From Client)', '#f43f5e', 4, false)
on conflict (id) do nothing;

update public.tasks set status = 'todo' where status = 'backlog';

delete from public.statuses where id = 'backlog';

update public.statuses set position = 0 where id = 'todo';
update public.statuses set position = 1 where id = 'in-progress';
update public.statuses set position = 2 where id = 'in-review';
update public.statuses set position = 3 where id = 'pending-payout';
update public.statuses set position = 4 where id = 'pending-payment';
update public.statuses set position = 5 where id = 'done';

-- Any other column a workspace added on its own keeps its relative order,
-- shifted to make room after the six above. Ordering by the old position
-- first (falling back to id for a tie) and re-deriving from scratch each run
-- is what keeps this idempotent: the second run sees positions that are
-- already 6, 7, 8… and reproduces exactly the same numbers.
with others as (
  select
    id,
    6 + row_number() over (order by position, id) - 1 as new_position
  from public.statuses
  where id not in (
    'todo', 'in-progress', 'in-review',
    'pending-payout', 'pending-payment', 'done'
  )
)
update public.statuses s
set position = others.new_position
from others
where s.id = others.id;
