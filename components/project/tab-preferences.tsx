"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DEFAULT_TAB_PREFS, PROJECT_TABS, moveTab, toggleTab, visibleTabs, type TabPrefs,
} from "@/lib/project-tabs";

/**
 * Which tabs this person sees on a project, and in what order.
 *
 * Arrows rather than drag, to match how Settings reorders board columns and to
 * keep a menu keyboard-operable. The last visible tab's checkbox is disabled so
 * the row cannot be emptied from here; `visibleTabs` falls back to the default
 * row anyway if the stored key is edited by hand.
 */
export function TabPreferences({
  prefs,
  onChange,
}: {
  prefs: TabPrefs;
  onChange: (next: TabPrefs) => void;
}) {
  const ordered = visibleTabs({ order: prefs.order, hidden: [] });
  const hidden = new Set(prefs.hidden);
  const shownCount = ordered.length - ordered.filter((t) => hidden.has(t.id)).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          // Icon-only: the name has to be explicit, a tooltip would not do it.
          aria-label="Customise tabs"
        >
          <SlidersHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <p className="mb-2 text-xs font-medium">Tabs on this project</p>
        <ul className="flex flex-col gap-1">
          {ordered.map((tab, i) => {
            const visible = !hidden.has(tab.id);
            const lastVisible = visible && shownCount === 1;
            return (
              <li key={tab.id} className="flex items-center gap-2">
                <Checkbox
                  id={`tab-pref-${tab.id}`}
                  checked={visible}
                  disabled={lastVisible}
                  onCheckedChange={(v) => onChange(toggleTab(prefs, tab.id, v === true))}
                />
                <Label htmlFor={`tab-pref-${tab.id}`} className="flex-1 text-[13px]">
                  {tab.label}
                </Label>
                <Button
                  variant="ghost" size="icon" className="size-6"
                  disabled={i === 0}
                  aria-label={`Move ${tab.label} earlier`}
                  onClick={() => onChange(moveTab(prefs, tab.id, -1))}
                >
                  <ChevronUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="size-6"
                  disabled={i === ordered.length - 1}
                  aria-label={`Move ${tab.label} later`}
                  onClick={() => onChange(moveTab(prefs, tab.id, 1))}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          variant="link" size="sm" className="mt-2 h-auto p-0 text-xs"
          onClick={() => onChange(DEFAULT_TAB_PREFS)}
        >
          Reset to default
        </Button>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Remembered on this device. {PROJECT_TABS.length} tabs available.
        </p>
      </PopoverContent>
    </Popover>
  );
}
