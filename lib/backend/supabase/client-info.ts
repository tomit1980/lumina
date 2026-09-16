/**
 * The client record, against Postgres.
 *
 * Four writes, and the database decides all four. `client_info_*` and
 * `client_documents_*` (20260914000200) require editor access to the project;
 * the two password calls are `security definer` RPCs that re-check the same
 * bar inline, because RLS is not consulted inside one. Nothing in this file
 * re-states an access rule — the store's guards exist for the message, and
 * these functions exist to carry the refusal back honestly.
 *
 * TWO COLUMNS ARE NEVER SENT FROM HERE, and that is the point rather than an
 * economy: `updated_at` and `updated_by` are written by a trigger from
 * `auth.uid()`. A client that could set them could lie about them.
 *
 * UPSERT, NOT INSERT-THEN-UPDATE. The record is created lazily by whichever
 * field somebody edits first, and no caller knows whether it is the first, so
 * every write is `upsert(..., { onConflict: "project_id" })`. That also makes
 * two people editing two different fields at once safe: each sends only its
 * own columns, and the merge happens in Postgres.
 */
import { fail, requireRows } from "./result";
import type { LuminaClient } from "./client";
import type { Database } from "../../database.types";
import type { ClientInfoPatch } from "../types";
import type { ClientNote } from "../../types";

/** The row shape PostgREST will accept, straight from the generated types —
 *  so a column renamed in a migration is a compile error here rather than a
 *  field that silently stops being written. */
type ClientInfoInsert = Database["public"]["Tables"]["project_client_info"]["Insert"];
type ClientNoteInsert = Database["public"]["Tables"]["project_client_notes"]["Insert"];

/** Model field → column. Written out rather than derived from a case
 *  transform, so a renamed field is a compile error here instead of a column
 *  that silently stops being written. */
const COLUMNS: Record<keyof ClientInfoPatch, string> = {
  fullName: "full_name",
  dateOfBirth: "date_of_birth",
  phone: "phone",
  email: "email",
  address: "address",
  superCompany: "super_company",
  memberId: "member_id",
  amount: "amount",
  currency: "currency",
  diagnosis: "diagnosis",
  lastDayOfWork: "last_day_of_work",
  employerName: "employer_name",
  contractSigned: "contract_signed",
  newPhone: "new_phone",
  newEmail: "new_email",
};

/**
 * Creates or patches the record.
 *
 * `.select()` on the upsert and `requireRows` afterwards: PostgREST reports a
 * write its policy filtered away as `error: null` with an empty body, so "no
 * error" is not the claim "it happened". That distinction is the one this
 * project has now got wrong seven times, and here it is the difference between
 * a viewer seeing their edit stick on screen and the write being refused.
 */
export async function updateClientInfo(
  client: LuminaClient,
  projectId: string,
  patch: ClientInfoPatch
): Promise<void> {
  const what = "saving the client details";

  const row: Record<string, unknown> = { project_id: projectId };
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = patch[field as keyof ClientInfoPatch];
    // `undefined` is "not in this patch"; `null` is a real value (an unknown
    // amount, a cleared date) and must be sent.
    if (value !== undefined) row[column] = value;
  }

  const result = await client
    .from("project_client_info")
    .upsert(row as ClientInfoInsert, { onConflict: "project_id" })
    .select("project_id");

  requireRows(what, "you may only view this project", result);
}

/** One document's received flag. */
export async function setClientDocument(
  client: LuminaClient,
  projectId: string,
  documentType: string,
  received: boolean
): Promise<void> {
  const result = await client
    .from("project_client_documents")
    .upsert(
      { project_id: projectId, document_type: documentType, received },
      { onConflict: "project_id,document_type" }
    )
    .select("project_id");

  requireRows(
    "saving that document",
    "you may only view this project",
    result
  );
}

/** Appends a note. `.select()` + `requireRows`, like every write here: a
 *  policy-filtered insert comes back as `error: null` with no rows. */
export async function addClientNote(
  client: LuminaClient,
  projectId: string,
  note: ClientNote
): Promise<void> {
  const row: ClientNoteInsert = { id: note.id, project_id: projectId, body: note.body };
  const result = await client.from("project_client_notes").insert(row).select("id");
  requireRows("adding that note", "you may only view this project", result);
}

/**
 * Stores, replaces or clears the client's account password.
 *
 * An RPC rather than a column write, because the value goes into Supabase
 * Vault and no browser session has rights there. The function raises on
 * refusal — plpgsql, not a filtered row — so unlike the two above there is
 * nothing to `requireRows` about: an error IS the refusal, and its message is
 * the sentence the database chose.
 */
export async function setClientPassword(
  client: LuminaClient,
  projectId: string,
  value: string | null
): Promise<void> {
  const { error } = await client.rpc("set_client_password", {
    p_project_id: projectId,
    // The generated signature says `string`, because Postgres does not mark
    // `text` as nullable and the generator has nothing else to go on. Null is
    // a real argument here - it is how a password is cleared - and the
    // function is written to take it.
    p_value: value as string,
  });
  if (error) fail("saving the client's password", error);
}

/**
 * Reads it back for one person who asked.
 *
 * The database writes the "revealed" line into the project's activity feed
 * inside this same transaction, before the value is read, so there is no
 * ordering in which somebody sees the password and the feed does not know.
 * Nothing in this file logs anything — a client-side log would be a claim
 * about a request rather than a record of one, and could simply be skipped.
 *
 * Resolves `null` when no password is stored: not an error, and still logged.
 */
export async function revealClientPassword(
  client: LuminaClient,
  projectId: string
): Promise<string | null> {
  const { data, error } = await client.rpc("reveal_client_password", {
    p_project_id: projectId,
  });
  if (error) fail("showing the client's password", error);
  // `Returns: string` for the same reason as above: a plpgsql function that
  // can return null is still typed non-null by the generator.
  return (data as string | null) ?? null;
}
