-- QA-103 — saving a document only worked for the person who uploaded it.
--
-- THE BUG. `attachment_objects_insert` (20260910001000_storage.sql) permits
-- writing bytes only behind a row you uploaded yourself:
-- `is_attachment_uploader`. The in-app editors' Save overwrites the object at
-- the same path, and Postgres evaluates the INSERT policy for that write, so
-- it never reached `attachment_objects_update` — which is the rule written
-- for this operation and would have allowed it (visible to you, and you hold
-- `project.create`). In a browser: Moshe saving his own new document
-- succeeded; Moshe saving a document whose uploader had left failed; and Dana
-- overwriting Moshe's file was refused with "new row violates row-level
-- security policy". A team tool whose documents only their creator can edit
-- is not a team tool, and it gets worse over time — `attachments.uploaded_by`
-- is `on delete set null`, so when someone leaves, every document they
-- uploaded becomes permanently unsaveable by anybody.
--
-- WHY THE CLIENT COULD NOT FIX THIS ALONE, which is worth recording because
-- it is not what reading the migration suggests. The obvious fix is to take
-- the update path — supabase-js's `storage.update()`, a PUT rather than a
-- POST — and lib/backend/supabase/storage.ts now does exactly that, for
-- reasons of its own. It is not sufficient: storage-api implements PUT as an
-- UPSERT, so Postgres still evaluates this INSERT policy's WITH CHECK for the
-- proposed row before it ever considers the conflict path. Verified against
-- lumina-dev, with the client already switched to `update()`:
-- tests/rls/storage.test.ts's "someone who did NOT upload the file can still
-- save it" still failed with the same message, while the sibling test in
-- which the saver IS the uploader passed. The insert rule is genuinely the
-- one refusing it.
--
-- WHAT THIS GRANTS, and it is deliberately nothing new. The second branch
-- below is `attachment_objects_update`'s predicate verbatim. Anyone it lets
-- through could already overwrite these bytes the moment storage-api issued a
-- plain UPDATE; this only stops the upsert's insert half from refusing what
-- its update half permits. The first branch is untouched, so the property the
-- original policy exists for still holds: a FRESH upload — bytes behind a row
-- nobody has linked to anything yet — is still restricted to the uploader,
-- and unlinked bytes are still visible to their uploader and to nobody else.
-- The permission checks on the LINK (project_attachments_insert /
-- task_attachments_insert / message authorship) are also untouched, so
-- nothing here changes who can make a file part of anything.
--
-- Read the two branches as one sentence: you may put bytes here if the row is
-- yours, or if the file is already something you can see and your role can
-- manage projects.
drop policy if exists attachment_objects_insert on storage.objects;

create policy attachment_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('project-files', 'task-files', 'message-files')
    and (
      public.is_attachment_uploader(public.attachment_of_object(name))
      or (
        public.can_see_attachment(public.attachment_of_object(name))
        and public.has_permission('project.create')
      )
    )
  );
