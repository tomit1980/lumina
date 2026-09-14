-- Supabase Vault, and proof that it works here.
--
-- THIS IS THE STOP POINT for the Client Info feature. That feature stores one
-- genuinely sensitive value - a client's account password - and the spec is
-- explicit that if the architecture cannot hold it securely, the field is
-- dropped rather than stored in the clear. So the decision is made here, by
-- the database, before a single line of UI exists: either this migration
-- applies and the field is buildable, or it fails loudly and the field is
-- deferred. There is no path from here to a plaintext column.
--
-- WHY THIS IS ITS OWN MIGRATION. Everything downstream depends on the answer,
-- and a failure buried inside a 400-line feature migration would roll back the
-- tables too and say nothing useful about which half was wrong. One file, one
-- question.
--
-- WHAT VAULT ACTUALLY BUYS, stated honestly so nobody later mistakes it for
-- more. Secrets are encrypted with an authenticated encryption key that lives
-- outside the database, so a `pg_dump`, a stolen backup, or a replica does not
-- carry the plaintext. It does NOT hide anything from whoever holds the
-- service key or the dashboard - they can decrypt at will. That is the ceiling
-- of a static export with no server of our own, and the Client Info design
-- works inside it: the value never reaches a general query, a hydrate, a
-- realtime payload, an activity line or browser storage, and every reveal is
-- recorded by the server before the caller sees anything.
--
-- `if not exists`: Supabase provisions this extension on new projects, so on
-- most databases this is a no-op that simply confirms the fact.
create extension if not exists supabase_vault with schema vault;

-- =====================================================================
-- The smoke test
-- =====================================================================
--
-- The extension being present is not the question. The question is whether a
-- `security definer` function owned by `postgres` - which is what
-- `set_client_password` and `reveal_client_password` will be - can create a
-- secret, read it back decrypted, and delete it. Those are three separate
-- privileges on objects owned by `supabase_admin`, and any one of them being
-- withheld would surface as a runtime failure in production rather than here.
--
-- So this block does exactly what those functions will do, on a throwaway
-- secret, and RAISES if the round trip does not hold. A migration that only
-- created the extension would "pass" on a database where the API is
-- unreachable - the class of verification instrument that lies.
--
-- It cleans up after itself in every path: the delete runs before the final
-- check, and an exception rolls the whole migration back anyway.
do $$
declare
  v_id      uuid;
  v_read    text;
  v_secret  text := 'vault-smoke-' || gen_random_uuid()::text;
begin
  v_id := vault.create_secret(
    v_secret,
    'lumina_vault_smoke_' || gen_random_uuid()::text,
    'Throwaway, created and deleted by migration 20260914000100.'
  );

  if v_id is null then
    raise exception 'Vault accepted a secret but returned no id.';
  end if;

  select s.decrypted_secret into v_read
    from vault.decrypted_secrets s
   where s.id = v_id;

  delete from vault.secrets where id = v_id;

  -- The assertion that matters. A null read, or a read that does not match
  -- what went in, means the decryption path is not available to this owner -
  -- and storing a client's password behind it would be storing it in a place
  -- nothing can get it back out of.
  if v_read is distinct from v_secret then
    raise exception
      'Vault did not round-trip: wrote a secret, read back %.',
      case when v_read is null then 'null' else 'a different value' end;
  end if;

  if exists (select 1 from vault.secrets where id = v_id) then
    raise exception 'Vault would not delete a secret it had just created.';
  end if;
end
$$;
