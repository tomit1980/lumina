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
