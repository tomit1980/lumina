# Creating a user

Lumina has no public sign-up. **Once the workspace has its first admin, you add
everybody else from inside the app** — Settings → Members → **Add teammate**.
Type their email, choose a password, pick a role; the account exists
immediately and they can sign in with it.

The dashboard route below is what you need *before* that is possible, and as a
fallback if it ever is not:

1. [Turn public sign-ups off](#1-turn-public-sign-ups-off) — do this once, before anything else.
2. [Promote the first admin](#2-promote-the-first-admin) — do this once, for yourself.
3. [Add a teammate](#3-add-a-teammate) — in the app; by hand only if you must.

Then, when you need it: [Two-factor](#two-factor) — what the app's controls do,
and the one case you have to handle in the dashboard.

Steps 1 and 2 happen in the Supabase dashboard for the project you are running
(**lumina-dev** `nsioivydefazicxnozqw` for development; the production project
is separate — check the ref in the URL before you touch anything).

---

## 1. Turn public sign-ups off

Do this **first**. Until you do, anyone who can reach the app's Supabase URL can
create themselves an account, and the trigger described below will dutifully
give them a Member profile with real access to your team's channels and boards.

**Authentication → Sign In / Providers → Email**

- Turn **Enable email signups** off. Depending on your dashboard's age the same
  switch is labelled **Allow new users to sign up** or **Enable sign ups**; there
  is only one, and it lives in the Email provider's panel.
- Leave **Confirm email** as you find it; with sign-ups off, nobody reaches it.
- Save.

With this off, the only way an account comes into existence is an admin adding
one by hand — which is the point.

Do it on **lumina-dev** now, and again on **lumina-prod** at cutover. The setting
is per project, so turning it off on one says nothing about the other.

**Why the app cannot do this for you.** Lumina ships as a static site with only
the publishable key. Sign-up is an Auth *server* setting; nothing the browser
holds can change it, and nothing in the app can stop `signUp()` being called
against your project directly with a key that is, by design, public. The
dashboard switch is the only thing that actually closes the door. The app never
calls `signUp()` — that is a design decision, not a control.

To confirm it took effect, look for a new account you did not create in
**Authentication → Users**. There should never be one.

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

### In the app — the normal way

**Settings → Members → Add teammate.** You need `members.manage`, which Admin
and Owner have.

| Field | Value |
|---|---|
| Email | their real work email |
| Name | optional; leave it and the trigger derives one from the address |
| First password | at least 8 characters — you choose it and tell them |
| Role | any role at or below your own rank |

The account is confirmed on creation, so they can sign in the moment you press
the button. Send them the address and the password; they change it themselves
from their account menu.

**You cannot hand out a role above your own.** An Admin adding an Owner is
refused by name, before the account is created — so there is no half-made user
left behind. The rule is re-checked server-side from your own token, not just
hidden in the interface.

**No email is sent.** That is deliberate: Supabase's shared mail service caps
the free tier at a handful of messages an hour, and an invitation that silently
does not arrive is worse than a password you read out loud.

Behind the button is the `create-user` Edge Function
(`supabase/functions/create-user/index.ts`). Creating an account needs the
service-role key, which bypasses every access rule in the database — a static
site cannot hold one, so this runs server-side. The button only appears on the
real backend; the local demo has no server to create anyone on.

### By hand, in the dashboard

Only needed before the first admin exists, or if the function is down.

**Authentication → Users → Add user → Create new user**

| Field | Value |
|---|---|
| Email address | their real work email |
| Password | a temporary one you send them |
| **Auto Confirm User** | **TICK THIS BOX** |

#### Auto Confirm User is not optional

**An unconfirmed user cannot sign in.** This was verified against lumina-dev,
not assumed: an account created without it exists in the users list, looks
completely normal, and then fails every sign-in attempt. There is no error
message that points at the cause.

If you have already created someone without it, you do not need to delete them —
open the user in **Authentication → Users**, and confirm their email from the
row's menu (or re-create them with the box ticked).

The app's own **Add teammate** passes `email_confirm` for you, which is why it
has no equivalent box and no equivalent trap.

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

1. Send the person their email address and the password you chose.
2. They sign in and can change their own name, handle, title and password.
3. If you added them by hand and they need more than Member access, promote
   them in the app: **Members → (person) → Role**. Adding them from the app
   sets the role at creation, so there is nothing to do here.

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
even though members can otherwise edit their own profile. See
[Two-factor](#two-factor) below for exactly what the app's controls can do.

---

## Two-factor

Two-factor is Supabase's own TOTP MFA. A person enrols from **their account
menu → Set up two-factor**, or is walked through enrolment at sign-in when you
have required it of them. Codes are verified by Supabase, not by the browser.

### What the People page can do

**Members → (person) → the two-factor button** writes `profiles.mfa_required`:

| Control | Effect |
|---|---|
| Require two-factor | `mfa_required = true`. They must enrol at their next sign-in before they reach the app. |
| Cancel requirement | `mfa_required = false`. An authenticator they already set up keeps working. |

### What it cannot do, and why

**You cannot see whether someone else has actually enrolled, and you cannot
remove their authenticator.** Both are `auth.admin` operations, and those need
the secret key — which bypasses every RLS policy and must never be in a browser
bundle. The app holds only the publishable key, so it does not pretend to know:
another person's badge reports *required* or *not required*, never *enrolled*.
The reset and disable actions therefore appear only on your own account, where
unenrolling is an ordinary self-service call.

**So: when someone loses their phone**, do it in the dashboard —
**Authentication → Users → (the person) → Remove MFA factor** (older dashboards
list it under the row's ⋯ menu). Leave `mfa_required` on, and they will be made
to enrol a new authenticator the next time they sign in.

Giving the app that button needs a server that can hold the secret key — an Edge
Function gated on `members.manage`. That is Phase 2 work; until then the
dashboard is the documented path, not a workaround.
