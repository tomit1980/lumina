// Creates (or re-creates) the two accounts the end-to-end browser pass signs in
// as, on lumina-dev only. Mirrors what the runbook tells the user to do in the
// dashboard: create the user with the email confirmed, let the trigger make the
// profile, then promote the first one to admin.
//
//   node tests/probes/e2e_users.mjs          # create
//   node tests/probes/e2e_users.mjs --clean  # remove them again
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env.test.local", quiet: true });

const URL = process.env.SUPABASE_URL;
const svc = createClient(URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const PASSWORD = "e2e-password-4417";
const PEOPLE = [
  { email: "moshe@lumina.test", name: "Moshe Cohen", handle: "moshe", role: "admin" },
  { email: "dana@lumina.test", name: "Dana Levi", handle: "dana", role: "member" },
];

if (URL.includes("eshstdmgceohizbevwll")) {
  console.log("REFUSING: that is the production project.");
  process.exit(1);
}

const { data: existing } = await svc.auth.admin.listUsers({ perPage: 200 });
for (const u of existing.users) {
  if (PEOPLE.some((p) => p.email === u.email)) await svc.auth.admin.deleteUser(u.id);
}

if (process.argv.includes("--clean")) {
  console.log("removed the end-to-end accounts");
  process.exit(0);
}

for (const person of PEOPLE) {
  const { data, error } = await svc.auth.admin.createUser({
    email: person.email,
    password: PASSWORD,
    email_confirm: true, // an unconfirmed user cannot sign in
  });
  if (error) throw new Error(`${person.email}: ${error.message}`);

  // The trigger already made a profile with the Member role and a derived
  // handle. Set the display name/handle we want, and promote the admin —
  // the same two steps the runbook describes.
  const { error: upErr } = await svc
    .from("profiles")
    .update({ name: person.name, handle: person.handle, role_id: person.role })
    .eq("id", data.user.id);
  if (upErr) throw new Error(`${person.email} profile: ${upErr.message}`);

  console.log(`${person.email}  ${person.role}  (${person.name})`);
}

const { data: profiles } = await svc.from("profiles").select("email,role_id,handle");
console.log("\nprofiles now:", profiles.map((p) => `${p.handle}[${p.role_id}]`).join(", "));
console.log("password:", PASSWORD);
