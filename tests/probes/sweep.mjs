import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
config({ path: ".env.test.local", quiet: true });
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data } = await svc.auth.admin.listUsers({ perPage: 200 });
// Only ever touch @lumina.test fixtures — never a real account.
const fixtures = data.users.filter((u) => (u.email ?? "").endsWith("@lumina.test"));
const real = data.users.length - fixtures.length;
console.log(`${data.users.length} user(s): ${fixtures.length} test fixture(s), ${real} other`);
if (real > 0) { console.log("REFUSING to sweep — a non-fixture account exists; inspect first."); process.exit(1); }
for (const u of fixtures) { await svc.auth.admin.deleteUser(u.id); console.log("  deleted", u.email); }
const after = await svc.auth.admin.listUsers({ perPage: 200 });
const { count } = await svc.from("profiles").select("id", { count: "exact", head: true });
console.log(`remaining: ${after.data.users.length} auth user(s), ${count} profile(s)`);
