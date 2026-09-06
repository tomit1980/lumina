"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";

import { AuthGate } from "@/components/auth/auth-gate";
import { SessionBridge } from "@/components/auth/session-bridge";
import {
  SelfEnrollDialog,
  SwitchTwoFactorPrompt,
} from "@/components/auth/two-factor-dialogs";
import { AccessDialog } from "@/components/access-dialog";
import { ChannelDialog } from "@/components/channel-dialog";
import { CommandPalette } from "@/components/command-palette";
import { DmDialog } from "@/components/dm-dialog";
import { ProjectDialog } from "@/components/project-dialog";
import { Reminders } from "@/components/reminders";
import { ShareFileDialog } from "@/components/share-file-dialog";
import { TaskDialog } from "@/components/task-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UIProvider } from "@/components/ui-context";
import { AuthProvider } from "@/lib/auth";
import { StoreProvider } from "@/lib/store";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <AuthProvider>
        <StoreProvider>
          <TooltipProvider delayDuration={200}>
            <UIProvider>
              <SessionBridge />
              <AuthGate>
                {children}
                <CommandPalette />
                <TaskDialog />
                <ChannelDialog />
                <ProjectDialog />
                <DmDialog />
                <AccessDialog />
                <ShareFileDialog />
                <SelfEnrollDialog />
                <SwitchTwoFactorPrompt />
                <Reminders />
              </AuthGate>
            </UIProvider>
          </TooltipProvider>
          <Toaster position="bottom-right" />
        </StoreProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
