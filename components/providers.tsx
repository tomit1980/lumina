"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { toast } from "sonner";

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

// React error boundaries (app/error.tsx, app/global-error.tsx) only catch
// throws during render and lifecycle methods. Once store actions return
// promises (the store-swap), every write runs from an event handler — a
// button's onClick calling an async action — so a refused or failed write
// that nobody explicitly `.catch`es becomes an *unhandled promise
// rejection*, not a render throw. Left unhandled, the button would just
// look dead: no toast, no boundary, nothing. This is a safety net, not the
// primary feedback path — actions are expected to toast their own denial or
// failure (see `deny()` and the persistence-failure toast in lib/store.tsx)
// — it only surfaces the ones that slip through.
//
// Deliberately not also listening for the `error` event: synchronous throws
// in event handlers already produce a visible console error and are a
// different, pre-existing class of bug unrelated to the async store-swap
// this net is for. A blanket `error` listener would also fire for things
// this app can't act on (third-party script errors, benign browser
// warnings) and could double-toast alongside the existing error boundaries.
export function useUnhandledRejectionToast() {
  React.useEffect(() => {
    const onUnhandledRejection = () => {
      toast.error("That last action didn't go through", {
        description: "Something went wrong. Please try again.",
      });
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);
}

export function Providers({ children }: { children: React.ReactNode }) {
  useUnhandledRejectionToast();
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
