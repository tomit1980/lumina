"use client";

import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import type { User } from "@/lib/types";

const MAX_COLLABORATOR_AVATARS = 2;

export interface StackedPerson {
  user: User;
  isOwner: boolean;
}

export interface PeopleStackResult {
  /** Avatars to actually render, owner first, capped at `maxCollaborators`. */
  shown: StackedPerson[];
  /** Collaborators past the visible cap — rendered as a single "+N" chip. */
  overflow: number;
  /** Everyone (owner + all collaborators), owner first — for the tooltip roster. */
  all: StackedPerson[];
}

/** Pure: decides which avatars a task's owner+collaborator stack shows, the
 *  "+N" overflow count, and the full tooltip roster. The owner is always
 *  first and is never counted toward the overflow. Used by both the kanban
 *  card and the list row (and their drag-overlay renders, which share the
 *  same content components). */
export function computePeopleStack(
  owner: User | undefined,
  collaborators: User[],
  maxCollaborators: number = MAX_COLLABORATOR_AVATARS
): PeopleStackResult {
  const ownerEntry: StackedPerson[] = owner ? [{ user: owner, isOwner: true }] : [];
  const all: StackedPerson[] = [
    ...ownerEntry,
    ...collaborators.map((user) => ({ user, isOwner: false })),
  ];
  const shown: StackedPerson[] = [
    ...ownerEntry,
    ...collaborators.slice(0, maxCollaborators).map((user) => ({ user, isOwner: false })),
  ];
  const overflow = Math.max(0, collaborators.length - maxCollaborators);
  return { shown, overflow, all };
}

/** Owner + collaborator avatar stack: owner first, then up to two
 *  collaborators, then a "+N" chip — matching the overlapping-avatar
 *  treatment already used for channel members (see chat-view.tsx). Renders
 *  nothing when there's nobody to show, so an unowned task with no
 *  collaborators leaves a clean empty slot rather than an empty container. */
export function PeopleStack({
  owner,
  collaborators,
}: {
  owner: User | undefined;
  collaborators: User[];
}) {
  if (!owner && collaborators.length === 0) return null;
  const { shown, overflow, all } = computePeopleStack(owner, collaborators);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center -space-x-1.5">
          {shown.map(({ user }) => (
            <UserAvatar
              key={user.id}
              user={user}
              size="sm"
              className="ring-2 ring-background"
            />
          ))}
          {overflow > 0 && (
            <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-background">
              +{overflow}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        {all.map(({ user, isOwner }) => (
          <span key={user.id}>
            {user.name}
            {isOwner && <span className="opacity-70"> · Owner</span>}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
