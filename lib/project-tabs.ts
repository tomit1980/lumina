/**
 * Which of a project's tabs a person sees, and in what order.
 *
 * A per-device preference rather than a workspace setting: it lives in
 * localStorage next to `lumina:reminder-sound`, needs no table, no policy and
 * no realtime, and is how nearly every app treats view customisation. If the
 * team later wants one shared layout, back these same functions with a table.
 *
 * Pure, so the invariants below are asserted in milliseconds:
 * unknown ids are ignored, ids missing from `order` are appended in default
 * order (a fifth tab added later appears rather than vanishing), duplicates
 * collapse, and an all-hidden preference shows the default row.
 */
export type ProjectView = "board" | "list" | "client" | "files";

export const PROJECT_TABS: ReadonlyArray<{ id: ProjectView; label: string }> = [
  { id: "board", label: "Board" },
  { id: "list", label: "List" },
  { id: "client", label: "Client Info" },
  { id: "files", label: "Files" },
];

export interface TabPrefs {
  order: ProjectView[];
  hidden: ProjectView[];
}

export const DEFAULT_TAB_PREFS: TabPrefs = {
  order: PROJECT_TABS.map((t) => t.id),
  hidden: [],
};

const STORAGE_KEY = "lumina:project-tabs";

const isView = (x: unknown): x is ProjectView =>
  PROJECT_TABS.some((t) => t.id === x);

export function visibleTabs(prefs: TabPrefs): Array<{ id: ProjectView; label: string }> {
  const seen = new Set<ProjectView>();
  const order: ProjectView[] = [];
  for (const id of [...prefs.order, ...PROJECT_TABS.map((t) => t.id)]) {
    if (isView(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  const hidden = new Set(prefs.hidden.filter(isView));
  const shown = order.filter((id) => !hidden.has(id));
  const ids = shown.length > 0 ? shown : PROJECT_TABS.map((t) => t.id);
  return ids.map((id) => PROJECT_TABS.find((t) => t.id === id)!);
}

export function moveTab(prefs: TabPrefs, id: ProjectView, direction: -1 | 1): TabPrefs {
  const order = visibleTabs({ order: prefs.order, hidden: [] }).map((t) => t.id);
  const from = order.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return prefs;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return { ...prefs, order: next };
}

export function toggleTab(prefs: TabPrefs, id: ProjectView, visible: boolean): TabPrefs {
  const hidden = prefs.hidden.filter((h) => h !== id);
  return { ...prefs, hidden: visible ? hidden : [...hidden, id] };
}

export function loadTabPrefs(): TabPrefs {
  if (typeof window === "undefined") return DEFAULT_TAB_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TAB_PREFS;
    const parsed = JSON.parse(raw) as Partial<TabPrefs>;
    return {
      order: Array.isArray(parsed.order) ? parsed.order.filter(isView) : DEFAULT_TAB_PREFS.order,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter(isView) : [],
    };
  } catch {
    return DEFAULT_TAB_PREFS;
  }
}

export function saveTabPrefs(prefs: TabPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable — the preference lasts for this page only.
  }
}
