"use client";

import * as React from "react";
import type { TaskStatus } from "@/lib/types";

export interface TaskDialogState {
  open: boolean;
  /** Editing an existing task when set. */
  taskId?: string;
  /** Preselected project for create mode. */
  projectId?: string;
  /** Preselected column for create mode. */
  status?: TaskStatus;
}

interface UIValue {
  paletteOpen: boolean;
  setPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>;
  taskDialog: TaskDialogState;
  openTaskDialog: (opts?: Omit<TaskDialogState, "open">) => void;
  closeTaskDialog: () => void;
  channelDialogOpen: boolean;
  setChannelDialogOpen: (open: boolean) => void;
  projectDialog: { open: boolean; editId?: string };
  /** Open the project dialog — pass a project id to edit, omit to create. */
  openProjectDialog: (editId?: string) => void;
  closeProjectDialog: () => void;
  dmDialogOpen: boolean;
  setDmDialogOpen: (open: boolean) => void;
  securityDialogOpen: boolean;
  setSecurityDialogOpen: (open: boolean) => void;
  passwordDialogOpen: boolean;
  setPasswordDialogOpen: (open: boolean) => void;
  /** Whose details are being edited. Carries a user id because the same
   *  dialog serves your own account menu and an admin's Members row. */
  profileDialog: { open: boolean; userId: string } | null;
  openProfileDialog: (userId: string) => void;
  closeProfileDialog: () => void;
  accessDialog: { open: boolean; kind: "channel" | "project"; id: string } | null;
  /** Open the "Manage access" dialog for a specific channel or project. */
  openAccessDialog: (kind: "channel" | "project", id: string) => void;
  closeAccessDialog: () => void;
  shareFileDialog: { open: boolean; projectId: string; attachmentId: string } | null;
  /** Open the "Share to chat" dialog for one of a project's files. */
  openShareFileDialog: (projectId: string, attachmentId: string) => void;
  closeShareFileDialog: () => void;
}

const UIContext = React.createContext<UIValue | null>(null);

export function UIProvider({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [taskDialog, setTaskDialog] = React.useState<TaskDialogState>({
    open: false,
  });
  const [channelDialogOpen, setChannelDialogOpen] = React.useState(false);
  const [projectDialog, setProjectDialog] = React.useState<{
    open: boolean;
    editId?: string;
  }>({ open: false });
  const [dmDialogOpen, setDmDialogOpen] = React.useState(false);
  const [securityDialogOpen, setSecurityDialogOpen] = React.useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = React.useState(false);
  const [profileDialog, setProfileDialog] = React.useState<UIValue["profileDialog"]>(null);
  const [accessDialog, setAccessDialog] = React.useState<UIValue["accessDialog"]>(null);
  const [shareFileDialog, setShareFileDialog] =
    React.useState<UIValue["shareFileDialog"]>(null);

  const value = React.useMemo<UIValue>(
    () => ({
      paletteOpen,
      setPaletteOpen,
      taskDialog,
      openTaskDialog: (opts) => setTaskDialog({ open: true, ...opts }),
      closeTaskDialog: () => setTaskDialog((d) => ({ ...d, open: false })),
      channelDialogOpen,
      setChannelDialogOpen,
      projectDialog,
      openProjectDialog: (editId) => setProjectDialog({ open: true, editId }),
      closeProjectDialog: () => setProjectDialog((d) => ({ ...d, open: false })),
      dmDialogOpen,
      setDmDialogOpen,
      securityDialogOpen,
      setSecurityDialogOpen,
      passwordDialogOpen,
      setPasswordDialogOpen,
      profileDialog,
      openProfileDialog: (userId) => setProfileDialog({ open: true, userId }),
      closeProfileDialog: () =>
        setProfileDialog((d) => (d ? { ...d, open: false } : d)),
      accessDialog,
      openAccessDialog: (kind, id) => setAccessDialog({ open: true, kind, id }),
      closeAccessDialog: () => setAccessDialog((d) => (d ? { ...d, open: false } : d)),
      shareFileDialog,
      openShareFileDialog: (projectId, attachmentId) =>
        setShareFileDialog({ open: true, projectId, attachmentId }),
      closeShareFileDialog: () =>
        setShareFileDialog((d) => (d ? { ...d, open: false } : d)),
    }),
    [
      paletteOpen,
      taskDialog,
      channelDialogOpen,
      projectDialog,
      dmDialogOpen,
      securityDialogOpen,
      passwordDialogOpen,
      profileDialog,
      accessDialog,
      shareFileDialog,
    ]
  );

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUI(): UIValue {
  const ctx = React.useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within a UIProvider");
  return ctx;
}
