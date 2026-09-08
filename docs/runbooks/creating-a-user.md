# Creating a user

Lumina has no public sign-up. Accounts are created by an admin in the Supabase
dashboard, and the database turns each new account into a Lumina member
automatically.

This runbook covers three things, in the order you need them:

1. [Turn public sign-ups off](#1-turn-public-sign-ups-off) — do this once, before anything else.
2. [Promote the first admin](#2-promote-the-first-admin) — do this once, for yourself.
3. [Add a teammate](#3-add-a-teammate) — do this for every person after that.

Everything below happens in the Supabase dashboard for the project you are
running (**lumina-dev** `nsioivydefazicxnozqw` for development; the production
project is separate — check the ref in the URL before you touch anything).

---

## 1. Turn public sign-ups off

Do this **first**. Until you do, anyone who can reach the app's Supabase URL can
create themselves an account, and the trigger described below will dutifully
give them a Member profile with real access to your team's channels and boards.

**Authentication → Sign In / Providers → Email**

- Turn **Allow new users to sign up** (also shown as "Enable sign ups") **off**.
- Leave **Confirm email** as you find it; with sign-ups off, nobody reaches it.
- Save.

With this off, the only way an account comes into existence is an admin adding
one by hand — which is the point.

---

## 2. Promote the first admin

Every profile is created on the **Member** role. That is deliberate: promotion
to admin is an act someone performs, not something the system does on its own.
So the very first account — yours — has to be promoted once, by hand.

Create your own account first using [step 3](#3-add-a-teammate) below, then:

**SQL Editor → New query**, and run this one line with your own email:

```sql
update public.profiles set role_id = 'admin' where email = 'you@example.com';
```

Expect `UPDATE 1`. If you get `UPDATE 0`, the profile does not exist yet —
re-read [step 3](#3-add-a-teammate), particularly the Auto Confirm box.

You only ever run this once. After that, admins are made in the app: **Members →
(person) → Role**, which is governed by the `members.manage` permission.

> **You cannot change your own role — not even as an admin.** The
> `profiles_block_self_role_change` trigger refuses it, and so does the app.
> That is why this first promotion has to be SQL and not a click. It also means
> a second admin has to be promoted *by* the first one, and that the last
> remaining admin cannot be demoted at all (`profiles_block_last_admin`).

---

## 3. Add a teammate

**Authentication → Users → Add user → Create new user**

Fill in:

| Field | Value |
|---|---|
| Email address | their real work email |
| Password | a temporary one you send them, or use **Send invite** instead |
| **Auto Confirm User** | **TICK THIS BOX** |

### Auto Confirm User is not optional

**An unconfirmed user cannot sign in.** This was verified against lumina-dev,
not assumed: an account created without it exists in the users list, looks
completely normal, and then fails every sign-in attempt. There is no error
message that points at the cause.

If you have already created someone without it, you do not need to delete them —
open the user in **Authentication → Users**, and confirm their email from the
row's menu (or re-create them with the box ticked).

If you prefer to invite rather than set a password, **Send invite** confirms the
address as part of the invitation flow and is equally fine.

### What happens automatically

The moment the auth user is created, the `handle_new_user` trigger
(`supabase/migrations/20260908000800_store_swap.sql`) creates their
`public.profiles` row inside the same transaction. You do not run any SQL, and
you do not touch the `profiles` table.

It fills in:

| Column | Value |
|---|---|
| `role_id` | `member` — always, for everyone, including the first account |
| `email` | the address you just entered |
| `name` | the email's local part, separators turned into spaces and title-cased — `jane.doe@acme.com` becomes "Jane Doe" |
| `handle` | the same local part, lowercased and stripped to letters and digits — `janedoe` |
| `mfa_required` | `false` |
| `title`, `color` | schema defaults; the person can set their own title in the app |

**Handles are made unique automatically.** If `janedoe` is taken (two people can
share a local part across two domains), the next person gets `janedoe2`, then
`janedoe3`, and so on. In the event of a genuine race between two simultaneous
sign-ups, the handle falls back to the local part plus a short slice of the
user's own id, which cannot collide. Nobody is ever turned away because a handle
was taken.

Names and handles are both editable afterwards — the derived values are a
starting point, not a decision.

### Then

1. Send the person their email address and temporary password (or the invite).
2. They sign in and can change their own name, handle, title and password.
3. If they need more than Member access, promote them in the app: **Members →
   (person) → Role**.

---

## Troubleshooting

**"Invalid login credentials" for a user you just created.**
Almost always the Auto Confirm box. Check **Authentication → Users** — the
account will show as unconfirmed. Confirm it, or re-create with the box ticked.

**They sign in, but the app behaves as if they are nobody** — no channels, no
boards, permission errors everywhere.
Their `profiles` row is missing. Check:

```sql
select id, email, role_id from public.profiles where email = 'them@example.com';
```

No row means the trigger did not fire. Confirm the migration is applied:

```sql
select tgname from pg_trigger where tgname = 'on_auth_user_created';
```

**Sign-up succeeded for someone you did not invite.**
Public sign-ups are still on. Go back to [step 1](#1-turn-public-sign-ups-off),
then remove the account in **Authentication → Users** (deleting the auth user
cascades and removes their profile too).

**You need to require two-factor for someone.**
That is the `profiles.mfa_required` column, set from the app by a holder of
`members.manage`. It is deliberately not settable by the person it applies to —
a member cannot clear their own requirement, and the database refuses the write
even though members can otherwise edit their own profile.
