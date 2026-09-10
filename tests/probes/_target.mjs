// Which database the probes talk to, and the one place that decides it.
//
// WHY THIS EXISTS. The probes create and delete real users. Three of the
// twelve carried a hard-coded `if (URL.includes(<prod ref>)) refuse`; the
// other nine did not, and would have run against production quite happily if
// `.env.test.local` had ever been pointed there. A guard that nine of twelve
// callers skip is not a guard — it is a habit. This makes the rule one thing
// that every probe imports, and makes running against production an explicit,
// visible act rather than a consequence of editing an env file.
//
// Default: `.env.test.local`, and production is REFUSED outright.
//
// To run against production — which is sanctioned exactly once, while it is
// empty, as the go-live plan's Task 1 describes:
//
//     LUMINA_PROBE_TARGET=production node tests/probes/<name>.mjs
//
// with credentials in `.env.prod.local` (gitignored). The flag is deliberately
// not a boolean: you have to type the word.
import { config } from "dotenv";

const PRODUCTION_REF = "eshstdmgceohizbevwll";
const target = process.env.LUMINA_PROBE_TARGET ?? "test";
const wantsProduction = target === "production";

config({ path: wantsProduction ? ".env.prod.local" : ".env.test.local", quiet: true });

const url = process.env.SUPABASE_URL ?? "";
if (!url) {
  console.log(
    `REFUSING: no SUPABASE_URL in ${wantsProduction ? ".env.prod.local" : ".env.test.local"}.`
  );
  process.exit(1);
}

const isProduction = url.includes(PRODUCTION_REF);

if (isProduction && !wantsProduction) {
  console.log("REFUSING: that is the production project.");
  process.exit(1);
}

// The mirror image, and the one that would otherwise be silent: asking for
// production and being handed something else means the env file is not what
// you think it is. Running the probes against development while believing
// they proved production is worse than not running them.
if (wantsProduction && !isProduction) {
  console.log(
    "REFUSING: LUMINA_PROBE_TARGET=production, but SUPABASE_URL in .env.prod.local is not the production project."
  );
  process.exit(1);
}

if (isProduction) {
  console.log(
    "\n*** RUNNING AGAINST PRODUCTION ***\n" +
      "These probes create and delete users. This is sanctioned only while the\n" +
      "workspace is empty (go-live plan, Task 1).\n"
  );
}

export const TARGET_IS_PRODUCTION = isProduction;
