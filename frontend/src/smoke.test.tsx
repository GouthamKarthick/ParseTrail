/**
 * @fileoverview Frontend smoke tests (Vitest + Testing Library).
 * Covers login validation, Upload file guards, and Detail refining/dead states.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { ReactNode } from "react";
import { isSuspiciousFrontend } from "./utils/security.ts";
import { isRefining } from "./hooks/usePolling.ts";
import { statusBadges } from "./utils/badges.ts";
import Login from "./pages/Login.tsx";
import Detail from "./pages/Detail.tsx";
import { AuthProvider } from "./context/AuthContext.tsx";
import { ToastProvider } from "./context/ToastContext.tsx";
import { login } from "./api/client.ts";

vi.mock("./api/client.ts", () => ({
  getDocument: vi.fn(),
  login: vi.fn(),
  me: vi.fn().mockResolvedValue({
    id: "u1",
    email: "user@example.com",
    first_name: "User",
    last_name: "One",
    email_verified: true,
  } as any),
  getAttempts: vi.fn().mockResolvedValue([]),
  listCorrections: vi.fn().mockResolvedValue([]),
  retryDocumentRefinement: vi.fn().mockResolvedValue({}),
}));

const mockLogin = vi.mocked(login);

function providers(children: ReactNode) {
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}

function renderAt(route: string, ui: React.ReactNode) {
  const router = createMemoryRouter(
    [{ path: route, element: providers(ui) }],
    { initialEntries: [route] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

describe("utils — file guards", () => {
  it("rejects suspicious file names", () => {
    expect(isSuspiciousFrontend("../../etc/passwd")).toBe(true);
    expect(isSuspiciousFrontend("select * from users")).toBe(true);
    expect(isSuspiciousFrontend("<script>alert(1)</script>")).toBe(true);
    expect(isSuspiciousFrontend("a".repeat(1001))).toBe(true);
  });
  it("accepts normal file names", () => {
    expect(isSuspiciousFrontend("invoice.pdf")).toBe(false);
    expect(isSuspiciousFrontend("receipt.png")).toBe(false);
    expect(isSuspiciousFrontend("")).toBe(false);
  });
});

describe("utils — refine status", () => {
  it("isRefining true while queued or working", () => {
    expect(isRefining({ status: "done", refine_status: "queued" } as any)).toBe(
      true,
    );
    expect(isRefining({ status: "done", refine_status: "working" } as any)).toBe(
      true,
    );
    expect(isRefining({ status: "done", refine_status: null } as any)).toBe(
      false,
    );
    expect(isRefining({ status: "done", refine_status: "done" } as any)).toBe(
      false,
    );
  });
});

describe("utils — status badges (Detail display logic)", () => {
  it("refining -> Enhancing with AI", () => {
    expect(statusBadges("done", "working")).toContainEqual({
      variant: "info",
      label: "Enhancing with AI",
    });
  });
  it("dead -> Ready + AI enhancement unavailable", () => {
    const badges = statusBadges("done", "dead");
    expect(badges.map((b) => b.label)).toContain("Ready");
    expect(badges.map((b) => b.label)).toContain("AI enhancement unavailable");
  });
  it("processing -> Processing", () => {
    expect(statusBadges("processing", null)).toContainEqual({
      variant: "warning",
      label: "Processing",
    });
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("Login page", () => {
  it("renders and calls login on submit", async () => {
    mockLogin.mockResolvedValue({
      id: "u1",
      email: "user@example.com",
      first_name: "User",
      last_name: "One",
      email_verified: true,
    } as any);

    renderAt("/login", <Login />);

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter your password"), {
      target: { value: "Password1!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /login/i }));

    await vi.waitFor(() =>
      expect(mockLogin).toHaveBeenCalledWith("user@example.com", "Password1!"),
    );
  });

  it("shows an error when login fails", async () => {
    mockLogin.mockRejectedValue(new Error("Invalid credentials"));

    renderAt("/login", <Login />);

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter your password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /login/i }));

    await vi.waitFor(() =>
      // getByText throws if the element is absent, so this asserts presence.
      expect(screen.getByText(/invalid credentials/i)).toBeTruthy(),
    );
  });
});

// ---------------------------------------------------------------------------
// Detail — mounting smoke test (state labels covered by statusBadges above)
// ---------------------------------------------------------------------------

describe("Detail page", () => {
  it("mounts within the router and shows Loading… until data resolves", () => {
    renderAt("/documents/doc-1", <Detail />);
    // getByText throws if the element is absent, so this asserts presence.
    screen.getByText(/loading…/i);
  });
});
