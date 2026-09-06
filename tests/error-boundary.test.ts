// @vitest-environment jsdom
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import ErrorBoundary from "@/app/error";
import GlobalError from "@/app/global-error";

type BoundaryProps = { error: Error & { digest?: string }; reset: () => void };

function makeError(digest?: string): Error & { digest?: string } {
  return Object.assign(new Error("boom"), { digest });
}

describe("error boundaries", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("app/error.tsx", () => {
    it("renders the heading and calls reset when 'Try again' is clicked", () => {
      const error = makeError();
      const reset = vi.fn();

      render(React.createElement(ErrorBoundary as React.FC<BoundaryProps>, { error, reset }));

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(reset).toHaveBeenCalledTimes(1);
    });

    it("renders the digest when the error carries one", () => {
      const error = makeError("abc123digest");
      const reset = vi.fn();

      render(React.createElement(ErrorBoundary as React.FC<BoundaryProps>, { error, reset }));

      expect(screen.getByText("abc123digest")).toBeInTheDocument();
    });

    it("logs the caught error to console.error", () => {
      const error = makeError();
      const reset = vi.fn();

      render(React.createElement(ErrorBoundary as React.FC<BoundaryProps>, { error, reset }));

      expect(console.error).toHaveBeenCalledWith("Lumina render error:", error);
    });
  });

  describe("app/global-error.tsx", () => {
    it("renders its heading and calls reset when 'Try again' is clicked", () => {
      // React warns about nesting <html> inside a container div here; that
      // warning is expected and harmless for this test.
      const error = makeError();
      const reset = vi.fn();

      render(React.createElement(GlobalError as React.FC<BoundaryProps>, { error, reset }));

      expect(screen.getByText("Lumina failed to start")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(reset).toHaveBeenCalledTimes(1);
    });
  });

  describe(".env.example", () => {
    it("documents the public Supabase variables", () => {
      const envPath = path.resolve(__dirname, "..", ".env.example");
      expect(existsSync(envPath)).toBe(true);
      const src = readFileSync(envPath, "utf8");
      expect(src).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(src).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    });
  });
});
