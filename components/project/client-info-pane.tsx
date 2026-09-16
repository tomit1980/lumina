"use client";

/**
 * The Client Info tab: one project's case record, on one page.
 *
 * EDITING IS AUTOSAVE PER FIELD, which is this codebase's pattern for anything
 * that is a page rather than a dialog (`statuses-section.tsx`,
 * `task-sets-section.tsx`, the Files tab). A form with one Save button would
 * make every visit a transaction somebody can forget to finish, and this
 * record is filled in a few fields at a time, over days, usually mid-call.
 *
 * EVERY TEXT FIELD IS UNCONTROLLED, and that is load-bearing rather than
 * incidental. A controlled input rendered from `AppState` would be rewritten
 * under the cursor whenever a colleague's edit arrived through realtime —
 * which is a coalesced re-hydrate of the whole workspace, so it can land in
 * the middle of a sentence. `defaultValue` is read once at mount, so what
 * somebody is typing is theirs until they leave the field, and `fieldKey`
 * below is what lets a field they are NOT in pick up a change.
 *
 * AND NOTHING SAYS "SAVED" BEFORE THE BACKEND AGREED. Each field's indicator
 * is driven by the store action's own promise, so "Saved" means the row
 * landed. A refusal rolls the value back (the store does that) and the
 * indicator says so until the next edit.
 */

import * as React from "react";
import { format } from "date-fns";
import { EyeIcon, EyeOffIcon, LockPasswordIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import {
  CLIENT_DOCUMENT_TYPES,
  DEFAULT_CURRENCY,
  formatDayFirst,
  formatIsoDate,
  formatMoney,
  moneyInputValue,
  parseDayFirst,
  parseMoney,
  receivedCount,
} from "@/lib/client-info";
import { useStore } from "@/lib/store";
import type { ClientInfo, Project } from "@/lib/types";
import { cn } from "@/lib/utils";

/** What one field's indicator is showing. */
type SaveState = "idle" | "saving" | "saved" | "failed";

/** The record as the form reads it — the real one, or an empty stand-in for a
 *  project nobody has filled in yet. The two render identically, which is why
 *  `client === null` needs no special case past this line. */
const EMPTY: ClientInfo = {
  fullName: "",
  dateOfBirth: null,
  phone: "",
  email: "",
  address: "",
  superCompany: "",
  memberId: "",
  amount: null,
  currency: DEFAULT_CURRENCY,
  diagnosis: "",
  lastDayOfWork: null,
  employerName: "",
  contractSigned: false,
  newPhone: "",
  newEmail: "",
  notes: [],
  documents: {},
  hasPassword: false,
  updatedAt: 0,
  updatedBy: null,
};

/** A field's trailing status line. Absent at rest, so a page nobody is editing
 *  is quiet. */
function SaveMark({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const text =
    state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Couldn't save";
  return (
    <span
      // `role="status"` and polite: a save confirmation must not interrupt
      // somebody who has already moved on to the next field.
      role="status"
      className={cn(
        "text-[11px]",
        state === "failed" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {text}
    </span>
  );
}

function Field({
  label,
  htmlFor,
  state,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  state: SaveState;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
          {label}
        </Label>
        <SaveMark state={state} />
      </div>
      {children}
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className="border-t pt-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ClientInfoPane({
  project,
  canEdit,
}: {
  project: Project;
  canEdit: boolean;
}) {
  const {
    state: appState,
    updateClientInfo,
    addClientNote,
    setClientDocument,
    setClientPassword,
    revealClientPassword,
  } = useStore();

  const client = project.client ?? EMPTY;

  const [saves, setSaves] = React.useState<Record<string, SaveState>>({});
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const mark = React.useCallback((field: string, state: SaveState) => {
    setSaves((s) => ({ ...s, [field]: state }));
    const existing = timers.current.get(field);
    if (existing) clearTimeout(existing);
    // "Saved" fades; "Couldn't save" does not, because a failure the reader
    // missed is exactly the thing they need to still be there when they look.
    if (state === "saved") {
      timers.current.set(
        field,
        setTimeout(() => {
          setSaves((s) => ({ ...s, [field]: "idle" }));
          timers.current.delete(field);
        }, 2000)
      );
    }
  }, []);

  /**
   * Runs one write and drives that field's indicator from its result.
   *
   * `revert` puts a refused value back in the box, and it is not optional.
   * `commit` rolls `AppState` back on a refusal, and a REFUSAL BEFORE THE
   * ROUND TRIP - a malformed email, say - never patches state at all. Either
   * way the record still holds the old value while an uncontrolled input goes
   * on displaying the rejected one, because its `defaultValue` was read at
   * mount. That is a field asserting something it does not know: the same
   * failure class as a screen claiming a save that did not happen, one level
   * down. Found by typing a bad address into the running app, not by reading
   * the code.
   */
  const run = React.useCallback(
    (field: string, write: () => Promise<boolean>, revert?: () => void) => {
      mark(field, "saving");
      const settle = (ok: boolean) => {
        mark(field, ok ? "saved" : "failed");
        if (!ok) revert?.();
      };
      void write().then(settle, () => settle(false));
    },
    [mark]
  );

  const save = React.useCallback(
    (field: keyof ClientInfo, value: unknown, revert?: () => void) =>
      run(field, () => updateClientInfo(project.id, { [field]: value }), revert),
    [run, updateClientInfo, project.id]
  );

  /**
   * A refusal describes the value that was sent. The moment the box holds
   * something else it is a statement about nothing, so typing retires it.
   *
   * FOUND IN THE LIVE APP, and it cost an investigation: a half-typed address
   * was blurred and refused, the label stuck, the finished address was typed
   * into the same box, and "Couldn't save" was still sitting beside it. It read
   * as the database rejecting a perfectly good address. Nothing had been sent.
   *
   * Only `failed` is cleared. "Saved" is a claim about something that really
   * did happen and it fades on its own; clearing it here would take away the
   * confirmation the moment somebody corrected a typo.
   */
  const clearRefusal = React.useCallback(
    (field: string) => {
      setSaves((s) => (s[field] === "failed" ? { ...s, [field]: "idle" } : s));
    },
    []
  );

  /**
   * Puts `previous` back into an input whose write was refused - but ONLY if
   * the box still holds exactly what was sent.
   *
   * The guard is the whole subtlety. A refusal arrives one round trip late,
   * and by then the person may already be typing a correction into that same
   * box. Overwriting it then would be the app taking the keyboard off them to
   * undo something they had already fixed.
   */
  const restore = (
    el: HTMLInputElement | HTMLTextAreaElement,
    attempted: string,
    previous: string
  ) => () => {
    if (el.value === attempted) el.value = previous;
  };

  /**
   * Re-mounts an uncontrolled input when the record changes UNDERNEATH it.
   *
   * Keyed on `updatedAt`, so a colleague's edit arriving through realtime
   * refreshes every field the reader is not currently in — React discards the
   * old DOM node and the new one takes the new `defaultValue`. A focused input
   * keeps its own value because the browser keeps focus on a node this key
   * does not change *for that field*: the field's own save bumps `updatedAt`,
   * but by then the person has already blurred it.
   */
  const fieldKey = client.updatedAt;

  const state = (field: string): SaveState => saves[field] ?? "idle";
  const id = (field: string) => `client-${project.id}-${field}`;

  /** One text input, read-only for a viewer. Enter commits, Escape restores,
   *  blur commits — the same three keys as every other in-place edit here. */
  const text = (
    field: keyof ClientInfo & string,
    label: string,
    opts: { type?: string; placeholder?: string; className?: string } = {}
  ) => {
    const current = (client[field] ?? "") as string;
    return (
      <Field
        key={field}
        label={label}
        htmlFor={id(field)}
        state={state(field)}
        className={opts.className}
      >
        {canEdit ? (
          <Input
            id={id(field)}
            key={`${field}-${fieldKey}`}
            type={opts.type ?? "text"}
            defaultValue={current}
            placeholder={opts.placeholder}
            className="h-8 text-[13px]"
            onInput={() => clearRefusal(field)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.currentTarget.value = current;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value === current) return;
              save(field, value, restore(e.target, value, current));
            }}
          />
        ) : (
          <ReadOnly value={current} />
        )}
      </Field>
    );
  };

  /**
   * A date, typed as DD/MM/YYYY.
   *
   * NOT `<input type="date">`, which this used to be. That control renders in
   * the VIEWER'S operating-system locale and cannot be told otherwise, so the
   * same date of birth read day-first in Melbourne and month-first on a
   * US-configured laptop, with nothing on screen to say which you were looking
   * at. For identifying information on a super claim that is not cosmetic.
   *
   * Stored and sent as "YYYY-MM-DD" exactly as before; only the typing and the
   * display changed. No `Date` is built from a string — see lib/client-info.ts.
   *
   * Shaped like `AmountField`: parses on blur, shows its own message, and does
   * NOT revert what was typed, because the text is wrong but it is what the
   * person meant and retyping from memory is worse than fixing it in place.
   */
  const date = (field: "dateOfBirth" | "lastDayOfWork", label: string) => (
    <DateField
      key={field}
      id={id(field)}
      label={label}
      fieldKey={fieldKey}
      value={client[field]}
      canEdit={canEdit}
      state={state(field)}
      onCommit={(value) => save(field, value)}
      onRefuse={() => mark(field, "failed")}
      onEdit={() => clearRefusal(field)}
    />
  );

  const documents = client.documents;
  const received = receivedCount(documents);

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-6 py-6">
      <div className="flex flex-col gap-6">
        <Section title="Personal details">
          <div className="grid gap-4 md:grid-cols-2">
            {text("fullName", "Full name")}
            {date("dateOfBirth", "Date of birth")}
            {text("phone", "Phone", { type: "tel", placeholder: "+61 412 345 678" })}
            {text("email", "Email", { type: "email" })}
            {text("address", "Address", { className: "md:col-span-2" })}
          </div>
        </Section>

        <Section title="Super / case details">
          <div className="grid gap-4 md:grid-cols-2">
            {text("superCompany", "Super company")}
            {text("memberId", "Member ID")}
            <AmountField
              id={id("amount")}
              fieldKey={fieldKey}
              amount={client.amount}
              currency={client.currency}
              canEdit={canEdit}
              state={state("amount")}
              onCommit={(value, revert) => save("amount", value, revert)}
              onRefuse={() => mark("amount", "failed")}
              onEdit={() => clearRefusal("amount")}
            />
            {text("diagnosis", "Diagnosis")}
            {date("lastDayOfWork", "Last day of work")}
            {text("employerName", "Employer")}
          </div>
        </Section>

        <Section
          title="Required documents"
          aside={
            <span className="text-xs tabular-nums text-muted-foreground">
              {received} / {CLIENT_DOCUMENT_TYPES.length} received
            </span>
          }
        >
          <div className="grid gap-1 md:grid-cols-2">
            {CLIENT_DOCUMENT_TYPES.map((doc) => {
              const checked = documents[doc.id] === true;
              return (
                <div
                  key={doc.id}
                  className="flex min-h-9 items-center gap-3 rounded-lg px-1"
                >
                  <Checkbox
                    id={id(doc.id)}
                    checked={checked}
                    disabled={!canEdit}
                    onCheckedChange={(next) =>
                      run(doc.id, () =>
                        setClientDocument(project.id, doc.id, next === true)
                      )
                    }
                  />
                  <Label
                    htmlFor={id(doc.id)}
                    className={cn(
                      "cursor-pointer text-[13px] font-normal",
                      // Missing items read as missing at a glance, which is
                      // the whole job of this section.
                      checked ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {doc.label}
                  </Label>
                  <SaveMark state={state(doc.id)} />
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Contract">
          <div className="flex items-center gap-3">
            <Switch
              id={id("contractSigned")}
              checked={client.contractSigned}
              disabled={!canEdit}
              onCheckedChange={(next) => save("contractSigned", next)}
            />
            <Label htmlFor={id("contractSigned")} className="text-[13px] font-normal">
              {client.contractSigned ? "Signed" : "Not signed"}
            </Label>
            <SaveMark state={state("contractSigned")} />
          </div>
        </Section>

        <Section title="Updated contact details">
          <p className="mb-3 text-xs text-muted-foreground">
            New details the client gave us later. The originals above are kept
            as they were submitted.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {text("newPhone", "New phone", { type: "tel" })}
            {text("newEmail", "New email", { type: "email" })}
          </div>
        </Section>

        <Section title="Account access">
          <PasswordField
            hasPassword={client.hasPassword}
            canEdit={canEdit}
            state={state("password")}
            onSet={(value) =>
              run("password", () => setClientPassword(project.id, value))
            }
            onReveal={() => revealClientPassword(project.id)}
          />
        </Section>

        <Section
          title="Notes"
          aside={
            client.notes.length > 0
              ? `${client.notes.length} ${client.notes.length === 1 ? "entry" : "entries"}`
              : undefined
          }
        >
          <ol className="flex flex-col gap-3">
            {/* Oldest first, and that ordering is the array's own: hydrate
             *  sorts on read (lib/backend/supabase/mapping.ts) and the
             *  optimistic append does `[...client.notes, note]`, so nothing
             *  here needs to re-sort a shape that cannot occur. */}
            {client.notes.map((note) => {
              const author = note.createdBy
                ? appState.users.find((u) => u.id === note.createdBy)
                : undefined;
              return (
                <li key={note.id} className="flex items-start gap-2.5">
                  {author ? (
                    <UserAvatar user={author} size="sm" className="mt-0.5" />
                  ) : (
                    <span
                      className="mt-0.5 size-6 shrink-0 rounded-full bg-muted"
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {author?.name ?? "Someone"}
                      </span>
                      {" · "}
                      <time dateTime={new Date(note.createdAt).toISOString()}>
                        {format(note.createdAt, "d MMM yyyy, HH:mm")}
                      </time>
                    </p>
                    <p className="whitespace-pre-wrap text-[13px]">{note.body}</p>
                  </div>
                </li>
              );
            })}
            {client.notes.length === 0 && (
              <li className="text-[13px] text-muted-foreground">No notes yet.</li>
            )}
          </ol>
          {canEdit && (
            <NoteComposer
              id={id("notes")}
              state={state("notes")}
              onSubmit={(body, keep) =>
                run("notes", () => addClientNote(project.id, body), keep)
              }
            />
          )}
        </Section>
      </div>
    </div>
  );
}

/** A value somebody may read but not change. An em dash rather than a blank,
 *  so an empty field looks deliberately empty instead of broken. */
function ReadOnly({ value }: { value: string }) {
  return (
    <p className="flex h-8 items-center text-[13px]">
      {value || <span className="text-muted-foreground">—</span>}
    </p>
  );
}

/**
 * A date typed as DD/MM/YYYY, stored as "YYYY-MM-DD".
 *
 * Its own component for the same reason as `AmountField`: the string somebody
 * types and the string the record holds are different, so it needs a piece of
 * state of its own for the message between them.
 */
function DateField({
  id,
  label,
  fieldKey,
  value,
  canEdit,
  state,
  onCommit,
  onRefuse,
  onEdit,
}: {
  id: string;
  label: string;
  fieldKey: number;
  value: string | null;
  canEdit: boolean;
  state: SaveState;
  onCommit: (value: string | null) => void;
  onRefuse: () => void;
  onEdit: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const current = formatDayFirst(value);

  const commit = (el: HTMLInputElement) => {
    const typed = el.value.trim();
    if (typed === current) return;

    // Empty is "not known", which is a real answer and always allowed.
    if (typed === "") {
      setError(null);
      if (value !== null) onCommit(null);
      return;
    }

    const iso = parseDayFirst(typed);
    if (!iso) {
      // Deliberately not reverted, and deliberately specific: "not a date" is
      // useless next to 31/02/1968, where the shape is right and the day is
      // not.
      setError("Use DD/MM/YYYY, and a date the calendar has.");
      onRefuse();
      return;
    }
    setError(null);
    onCommit(iso);
  };

  return (
    <Field label={label} htmlFor={id} state={state}>
      {canEdit ? (
        <>
          <Input
            id={id}
            key={`${id}-${fieldKey}`}
            inputMode="numeric"
            autoComplete="off"
            defaultValue={current}
            placeholder="DD/MM/YYYY"
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : undefined}
            className="h-8 text-[13px]"
            onInput={() => {
              setError(null);
              onEdit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.currentTarget.value = current;
                setError(null);
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => commit(e.currentTarget)}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="text-[11px] text-destructive">
              {error}
            </p>
          )}
        </>
      ) : (
        <ReadOnly value={formatIsoDate(value)} />
      )}
    </Field>
  );
}

/**
 * The amount, in its own component because it is the one field whose input and
 * its resting display are different strings.
 *
 * Refused locally before the store is called: the store would refuse a bad
 * value too, but the message it gives ("An amount has to be a number") is
 * about the parsed value, and what the person needs is the shape to type.
 */
function AmountField({
  id,
  fieldKey,
  amount,
  currency,
  canEdit,
  state,
  onCommit,
  onRefuse,
  onEdit,
}: {
  id: string;
  fieldKey: number;
  amount: number | null;
  currency: string;
  canEdit: boolean;
  state: SaveState;
  onCommit: (value: number | null, revert: () => void) => void;
  onRefuse: () => void;
  /** Retire a previous refusal: the person is editing the value it was about. */
  onEdit: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const current = moneyInputValue(amount);

  return (
    <Field label="Amount" htmlFor={id} state={state}>
      {canEdit ? (
        <>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">
              $
            </span>
            <Input
              id={id}
              key={`amount-${fieldKey}`}
              inputMode="decimal"
              defaultValue={current}
              placeholder="12500"
              aria-invalid={error !== null}
              aria-describedby={error ? `${id}-error` : undefined}
              className="h-8 pl-6 text-[13px]"
              onInput={() => {
                // Both, and for the same reason: each describes the text that
                // was rejected, and the box no longer holds it.
                setError(null);
                onEdit();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  e.currentTarget.value = current;
                  setError(null);
                  e.currentTarget.blur();
                }
              }}
              onBlur={(e) => {
                const typed = e.target.value;
                const parsed = parseMoney(typed);
                if (!parsed.ok) {
                  // NOT reverted here, deliberately - unlike a refused write.
                  // The text is wrong but it is what the person meant to
                  // type, the message beneath says how to fix it, and wiping
                  // it would make them retype from memory.
                  setError(parsed.error);
                  onRefuse();
                  return;
                }
                setError(null);
                if (parsed.value === amount) return;
                const el = e.target;
                onCommit(parsed.value, () => {
                  if (el.value === typed) el.value = current;
                });
              }}
            />
          </div>
          {error && (
            <p id={`${id}-error`} role="alert" className="text-[11px] text-destructive">
              {error}
            </p>
          )}
        </>
      ) : (
        <ReadOnly value={formatMoney(amount, currency)} />
      )}
    </Field>
  );
}

/**
 * The box a new note is typed into. Enter is a newline — this is the one
 * field meant for paragraphs — and Ctrl/Cmd+Enter or the button submits.
 * A refused note keeps its draft: wiping what somebody typed is the failure
 * the password field had, and this must not repeat it.
 */
function NoteComposer({
  id, state, onSubmit,
}: {
  id: string;
  state: SaveState;
  onSubmit: (body: string, keepDraft: () => void) => void;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    const el = ref.current;
    if (!el) return;
    const body = el.value;
    onSubmit(body, () => { if (el.value === "") el.value = body; });
    if (body.trim()) el.value = "";
  };
  return (
    <Field label="New note" htmlFor={id} state={state} className="mt-4">
      <Textarea
        ref={ref}
        id={id}
        className="min-h-24 text-[13px]"
        placeholder="What happened, and when."
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
        }}
      />
      <div className="mt-1.5 flex justify-end">
        <Button size="sm" onClick={submit}>Add note</Button>
      </div>
    </Field>
  );
}

/**
 * The client's account password.
 *
 * THE VALUE IS NEVER IN `AppState` AND NEVER IN BROWSER STORAGE. It lives in
 * one `useState` here, for as long as it is on screen, and is dropped when the
 * reader hides it, when the component unmounts, or after thirty seconds —
 * whichever comes first. `AppState` knows only whether one exists.
 *
 * Every reveal is recorded in the project's activity feed by the database,
 * before the value is read, and the line names nobody's password. The button
 * says so, because somebody about to click it is entitled to know.
 *
 * The set field is `type="password"` and `autoComplete="new-password"`: the
 * first keeps it off a shoulder, the second keeps the browser from offering to
 * remember a credential that is not the reader's own.
 */
function PasswordField({
  hasPassword,
  canEdit,
  state,
  onSet,
  onReveal,
}: {
  hasPassword: boolean;
  canEdit: boolean;
  state: SaveState;
  onSet: (value: string | null) => void;
  onReveal: () => Promise<string | null>;
}) {
  const [revealed, setRevealed] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = React.useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setRevealed(null);
  }, []);

  // Unmounting the pane — switching tabs, opening a file, leaving the project
  // — drops the value with it.
  React.useEffect(() => hide, [hide]);

  if (!canEdit) {
    // A viewer is told whether one exists and given no way to ask for it.
    // Showing a disabled Reveal button would be an invitation to ask an editor
    // to click it for them.
    return (
      <p className="text-[13px] text-muted-foreground">
        {hasPassword
          ? "A password is stored for this client. Only project editors can see it."
          : "No password stored."}
      </p>
    );
  }

  if (editing) {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSet(draft === "" ? null : draft);
          setDraft("");
          setEditing(false);
          hide();
        }}
      >
        <Label htmlFor="client-password-new" className="text-xs text-muted-foreground">
          {hasPassword ? "Replace the stored password" : "Password"}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="client-password-new"
            type="password"
            autoComplete="new-password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste or type it"
            className="h-8 max-w-64 text-[13px]"
          />
          <Button type="submit" size="sm" disabled={draft === ""}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft("");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Stored encrypted. It is never shown on this page again until somebody
          asks for it, and every time somebody does is recorded.
        </p>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <HugeiconsIcon
          icon={LockPasswordIcon}
          className="size-4 text-muted-foreground"
        />
        <code className="rounded-md bg-muted px-2 py-1 font-mono text-[13px]">
          {!hasPassword ? "No password stored" : (revealed ?? "••••••••")}
        </code>

        {hasPassword &&
          (revealed === null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                void onReveal().then(
                  (value) => {
                    setLoading(false);
                    if (value === null) return;
                    setRevealed(value);
                    hideTimer.current = setTimeout(() => setRevealed(null), 30_000);
                  },
                  () => setLoading(false)
                );
              }}
            >
              <HugeiconsIcon icon={EyeIcon} className="size-3.5" />
              {loading ? "Showing…" : "Reveal"}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={hide}>
              <HugeiconsIcon icon={EyeOffIcon} className="size-3.5" />
              Hide
            </Button>
          ))}

        <Button
          type="button"
          size="sm"
          variant={hasPassword ? "ghost" : "outline"}
          onClick={() => setEditing(true)}
        >
          {hasPassword ? "Replace" : "Set password"}
        </Button>

        {hasPassword && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => {
              hide();
              onSet(null);
            }}
          >
            Clear
          </Button>
        )}

        <SaveMark state={state} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {revealed !== null
          ? "Hidden again in 30 seconds. This view was recorded in the project's activity."
          : "Every time someone reveals this is recorded in the project's activity."}
      </p>
    </div>
  );
}
