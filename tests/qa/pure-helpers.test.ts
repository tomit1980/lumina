// @vitest-environment jsdom
//
// Suite A9 — pure helpers with no store/permission involvement:
// lib/calendar.ts's iCalendar generation (RFC 5545 text escaping and
// well-formed VEVENT/VALARM structure) and components/chat/rich-text.tsx's
// single-pass regex tokenizer (bold/italic/code/mention, and the
// no-nesting-support case recorded as actual behavior, not assumed).
import * as React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { taskToICS, tasksToICS } from "@/lib/calendar";
import { RichText } from "@/components/chat/rich-text";
import type { Task, User } from "@/lib/types";

afterEach(() => {
  cleanup();
});

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t_ics",
    projectId: "p_ics",
    title: "Task",
    description: "",
    status: "todo",
    priority: "medium",
    assigneeId: null,
    dueDate: Date.UTC(2026, 6, 14), // 2026-07-14 local midnight (UTC here is fine for structure checks)
    startTime: null,
    durationMinutes: null,
    reminderMinutes: null,
    labels: [],
    attachments: [],
    order: 0,
    createdAt: Date.now(),
    createdBy: "u_vlad",
    collaboratorIds: [],
    ...overrides,
  };
}

describe("lib/calendar.ts — iCalendar text escaping (RFC 5545)", () => {
  it("escapes backslash, semicolon, comma, and newline in the title, and keeps SUMMARY on one logical line", () => {
    const title = "Report; Q1, draft\\v2\nContinued";
    const task = baseTask({ title, startTime: "09:00", durationMinutes: 30 });
    const ics = taskToICS(task);
    const lines = ics.split("\r\n");

    // Escaping order in the source is \ then ; then , then newline, so a
    // literal backslash in the input becomes doubled, not re-escaped by the
    // later ";"/","/"\n" passes.
    const expectedSummary = "SUMMARY:Report\\; Q1\\, draft\\\\v2\\nContinued";
    expect(lines).toContain(expectedSummary);

    // The escaped newline is textual ("\n" as two characters), not a real
    // line break — SUMMARY must still be exactly one CRLF-delimited line.
    const summaryLines = lines.filter((l) => l.startsWith("SUMMARY:"));
    expect(summaryLines).toHaveLength(1);
  });

  it("escapes the same special characters in DESCRIPTION", () => {
    const task = baseTask({ description: "Steps: a,b;c\\d" });
    const ics = taskToICS(task);
    expect(ics).toContain("DESCRIPTION:Steps: a\\,b\\;c\\\\d");
  });
});

describe("lib/calendar.ts — well-formed VEVENT structure", () => {
  it("a timed task (dueDate + startTime) produces UTC DTSTART/DTEND and a VALARM when reminderMinutes is set", () => {
    const task = baseTask({ startTime: "14:30", durationMinutes: 45, reminderMinutes: 10 });
    const ics = taskToICS(task);
    const lines = ics.split("\r\n");

    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain(`UID:${task.id}@lumina.local`);
    expect(lines.some((l) => /^DTSTART:\d{8}T\d{6}Z$/.test(l))).toBe(true);
    expect(lines.some((l) => /^DTEND:\d{8}T\d{6}Z$/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("DTSTART;VALUE=DATE:"))).toBe(false);

    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("END:VALARM");
    expect(ics).toContain("ACTION:DISPLAY");
    expect(ics).toContain("TRIGGER:-PT10M");
  });

  it("an all-day task (dueDate, no startTime) uses VALUE=DATE and never emits a VALARM, even with reminderMinutes set", () => {
    const task = baseTask({ startTime: null, reminderMinutes: 15 });
    const ics = taskToICS(task);
    expect(ics).toContain("DTSTART;VALUE=DATE:");
    expect(ics).toContain("DTEND;VALUE=DATE:");
    expect(ics).not.toContain("BEGIN:VALARM");
  });

  it("a task with no dueDate at all produces an empty (but well-formed) calendar shell", () => {
    const task = baseTask({ dueDate: null });
    const ics = tasksToICS([task]);
    expect(ics).not.toContain("BEGIN:VEVENT");
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.trim().endsWith("END:VCALENDAR")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const USERS: User[] = [
  { id: "u_sam", name: "Sam Okafor", handle: "sam", title: "PM", roleId: "member", color: "#000", presence: "online" },
];

function renderRichText(content: string, currentUserId = "u_sam") {
  const { container } = render(
    React.createElement(RichText, { content, users: USERS, currentUserId })
  );
  return container;
}

describe("components/chat/rich-text.tsx — the tokenizer's basic tokens", () => {
  it("**bold**", () => {
    const container = renderRichText("**bold**");
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("bold");
  });

  it("*italic*", () => {
    const container = renderRichText("*italic*");
    const em = container.querySelector("em");
    expect(em?.textContent).toBe("italic");
  });

  it("`code`", () => {
    const container = renderRichText("`code`");
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("code");
  });

  it("@mention resolves a known handle (case-insensitively)", () => {
    const container = renderRichText("hey @SAM check this");
    expect(container.textContent).toBe("hey @sam check this");
    // RichText's own root is a <span>, so the mention pill is the *second*
    // span in document order, not the first.
    const spans = container.querySelectorAll("span");
    expect(spans).toHaveLength(2);
    expect(spans[1].className).toContain("amber"); // own mention gets "self" styling
  });

  it("@mention for someone else gets the non-self styling", () => {
    const container = renderRichText("hey @sam", "u_other");
    const spans = container.querySelectorAll("span");
    expect(spans).toHaveLength(2);
    expect(spans[1].className).toContain("primary");
  });

  it("an @mention for an unknown handle renders as plain literal text (no pill span at all)", () => {
    const container = renderRichText("hey @nobody here");
    expect(container.querySelectorAll("span")).toHaveLength(1); // just RichText's own root span
    expect(container.textContent).toBe("hey @nobody here");
  });
});

describe("components/chat/rich-text.tsx — unmatched and adjacent markers", () => {
  it("an unclosed single asterisk renders as literal text, not italic", () => {
    const container = renderRichText("*unclosed");
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("*unclosed");
  });

  it("an unclosed double asterisk renders as literal text, not bold", () => {
    const container = renderRichText("**unclosed");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("**unclosed");
  });

  it("two separate bold tokens, space-separated, both render as bold", () => {
    const container = renderRichText("**a** **b**");
    const strongs = container.querySelectorAll("strong");
    expect(Array.from(strongs).map((s) => s.textContent)).toEqual(["a", "b"]);
  });

  it("two bold tokens touching with no separator both still render as bold", () => {
    const container = renderRichText("**a****b**");
    const strongs = container.querySelectorAll("strong");
    expect(Array.from(strongs).map((s) => s.textContent)).toEqual(["a", "b"]);
  });
});

describe("components/chat/rich-text.tsx — nesting is NOT supported (actual, not assumed, behavior)", () => {
  // The tokenizer is a single-pass regex with no nesting: **[^*\n]+** requires
  // the bold content to contain no asterisks at all, so it can never match
  // across a nested *italic* span. Tracing what the regex actually matches
  // for "**bold *italic* still bold**":
  //   - No alternative matches starting at index 0 (two lone leading
  //     asterisks can't complete either the "**...**" or "*...*" form there).
  //   - The first real match found is the *italic*-style single-asterisk
  //     alternative starting at index 1: "*bold *" (i.e. "*" + "bold " up to
  //     the next asterisk + "*").
  //   - Next match: "* still bold*" (from the closing "*" of "*italic*"
  //     through to the second-to-last asterisk).
  //   - That leaves one leading "*" and one trailing "*" as stray literal
  //     text, "italic" itself as plain unstyled text, and the words "bold"/
  //     "still bold" wrongly wrapped in <em> (italic) rather than <strong>
  //     (bold) or nested emphasis.
  it("'**bold *italic* still bold**' misrenders instead of nesting", () => {
    const container = renderRichText("**bold *italic* still bold**");

    expect(container.querySelector("strong")).toBeNull(); // never becomes bold
    const ems = container.querySelectorAll("em");
    expect(Array.from(ems).map((e) => e.textContent)).toEqual(["bold ", " still bold"]);

    // "italic" itself ends up as unstyled plain text, not emphasized.
    expect(container.textContent).toBe("*bold italic still bold*");
  });
});
