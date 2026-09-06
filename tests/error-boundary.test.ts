import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("error boundaries", () => {
  it("defines a route-level error boundary", () => {
    expect(existsSync("app/error.tsx")).toBe(true);
    const src = readFileSync("app/error.tsx", "utf8");
    expect(src).toContain('"use client"');
    expect(src).toContain("export default function");
    expect(src).toContain("reset");
  });

  it("defines a global error boundary with its own html shell", () => {
    expect(existsSync("app/global-error.tsx")).toBe(true);
    const src = readFileSync("app/global-error.tsx", "utf8");
    expect(src).toContain('"use client"');
    expect(src).toContain("<html");
    expect(src).toContain("<body");
  });

  it("documents the public Supabase variables", () => {
    expect(existsSync(".env.example")).toBe(true);
    const src = readFileSync(".env.example", "utf8");
    expect(src).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(src).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
});
