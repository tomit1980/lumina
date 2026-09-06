"use client";

import { Sparkles } from "lucide-react";

import { LoginScreen } from "@/components/auth/login-screen";
import { useAuth } from "@/lib/auth";

/** Gates the whole app behind authentication. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { ready, session } = useAuth();

  if (!ready) {
    return (
      <div className="flex h-svh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="flex size-11 animate-pulse items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-lg">
            <Sparkles className="size-5" />
          </div>
          <span className="text-xs text-muted-foreground">Securing your session…</span>
        </div>
      </div>
    );
  }

  if (!session) return <LoginScreen />;
  return <>{children}</>;
}
