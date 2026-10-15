/**
 * @fileoverview Typed HTTP client for ClarityDocs backend API.
 * Wraps fetch with credential handling, error mapping via ApiError, and typed responses.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE =
  (import.meta.env.VITE_BACKEND_URL as string) ||
  (import.meta.env.VITE_API_URL as string) ||
  "";

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

/**
 * Register a new user account.
 * @param email - User email address
 * @param password - Plain-text password
 * @returns Created user id and email
 * @example await register("you@example.com", "P@ssw0rd!");
 */
export async function register(
  first_name: string,
  last_name: string,
  email: string,
  password: string,
) {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ first_name, last_name, email, password }),
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || "Register failed", res.status);
  return body as {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    email_verified: boolean;
    verification_email_sent: boolean;
  };
}

/**
 * Update profile text fields.
 * Phone always editable; first/last only accepted when currently empty (legacy).
 */
export async function updateProfile(data: {
  phone?: string | null;
  first_name?: string;
  last_name?: string;
}) {
  const res = await fetch(`${API_BASE}/api/auth/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || "Update failed", res.status);
  return body;
}

export async function getAvatar() {
  const res = await fetch(`${API_BASE}/api/auth/avatar`, {
    credentials: "include",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError("Avatar fetch failed", res.status);
  return (await res.json()) as {
    avatar_base64: string;
    mime: string;
    size_bytes: number;
  };
}

export async function putAvatar(avatar_base64: string) {
  const res = await fetch(`${API_BASE}/api/auth/avatar`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ avatar_base64 }),
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(body.error || "Avatar upload failed", res.status);
  return body;
}

export async function deleteAvatar() {
  const res = await fetch(`${API_BASE}/api/auth/avatar`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new ApiError("Avatar delete failed", res.status);
  return true;
}

export async function resendVerification(email: string) {
  const res = await fetch(`${API_BASE}/api/auth/resend-verification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return res.json().catch(() => ({}));
}

/**
 * Authenticate an existing user.
 * @param email - User email
 * @param password - User password
 * @returns Response body on success
 * @example await login("you@example.com", "P@ssw0rd!");
 */
export async function login(email: string, password: string) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || "Login failed", res.status);
  return body as {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    email_verified: boolean;
  };
}

/**
 * Log out the current session.
 * @returns Resolves when logout request completes
 * @example await logout();
 */
export async function logout() {
  await fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

/**
 * Fetch the currently authenticated user.
 * @returns User profile payload
 * @throws {ApiError} When not authenticated
 * @example const user = await me();
 */
export async function me() {
  const res = await fetch(`${API_BASE}/api/auth/me`, {
    credentials: "include",
  });
  if (!res.ok) throw new ApiError("Not authenticated", res.status);
  return (await res.json()) as {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    phone?: string | null;
    email_verified: number | boolean;
    created_at: string;
  };
}

// ---------------------------------------------------------------------------
// Analytics & Export
// ---------------------------------------------------------------------------

/**
 * Fetch 30-day aggregated summary statistics.
 * @param category - Optional document category filter
 * @returns Summary payload with totals, trends, and breakdowns
 * @example const summary = await getSummary("financial");
 */
export async function getSummary(category?: string) {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  const res = await fetch(`${API_BASE}/api/documents/summary${qs}`, {
    credentials: "include",
  });
  if (!res.ok) throw new ApiError("Summary failed", res.status);
  return (await res.json()) as {
    totalDocs: number;
    sumTotal: number;
    avgUsage: number;
    avgConfidence: number;
    byType: { document_type: string; cnt: number; sum: number }[];
    trend: { date: string; cnt: number; sum: number }[];
    topVendors: { vendor: string; cnt: number; sum: number }[];
  };
}

/**
 * Export the summary report as a downloadable blob.
 * @param format - Export file type (pdf or csv)
 * @param category - Optional category filter
 * @returns Blob for download
 * @example const blob = await exportSummary("pdf");
 */
export async function exportSummary(
  format: "pdf" | "csv" = "pdf",
  category?: string,
) {
  const qs = category
    ? `?format=${format}&category=${encodeURIComponent(category)}`
    : `?format=${format}`;
  const res = await fetch(`${API_BASE}/api/documents/summary/export${qs}`, {
    credentials: "include",
  });
  if (!res.ok) throw new ApiError("Export failed", res.status);
  return await res.blob();
}

// ---------------------------------------------------------------------------
// Password Reset
// ---------------------------------------------------------------------------

/**
 * Request a password-reset email.
 * @param email - Account email
 * @returns Backend response body
 * @example await forgotPassword("you@example.com");
 */
export async function forgotPassword(email: string) {
  const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await res.json().catch(() => ({}));
  return body;
}

/**
 * Reset password using a one-time token.
 * @param token - Reset token from email link
 * @param password - New password
 * @returns Backend response body
 * @example await resetPassword(token, "NewP@ss1!");
 */
export async function resetPassword(token: string, password: string) {
  const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || "Reset failed", res.status);
  return body;
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

/**
 * Structured API error carrying HTTP status and optional machine code.
 * @example throw new ApiError("Not found", 404);
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  duplicateOf?: string;

  /**
   * Create an ApiError.
   * @param message - Human-readable message
   * @param status - HTTP status code
   * @param code - Optional backend error code
   * @param duplicateOf - Duplicate document id when status 409
   */
  constructor(
    message: string,
    status: number,
    code?: string,
    duplicateOf?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.duplicateOf = duplicateOf;
  }
}

// ---------------------------------------------------------------------------
// Document API
// ---------------------------------------------------------------------------

/**
 * Upload a single document file.
 * @param file - File selected by the user
 * @returns Created document metadata
 * @example await uploadDocument(file);
 */
export async function uploadDocument(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/api/documents/upload`, {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new ApiError(
      body.error || "Upload failed",
      res.status,
      body.code,
      body.duplicateOf,
    );
  }
  // 409 is handled as error above, but keep for success shape
  return body as {
    id: string;
    name: string;
    status: string;
    created_at: string;
    document_type?: string;
    data?: unknown;
  };
}

/**
 * List documents with pagination and optional filters.
 * @param limit - Page size
 * @param offset - Page offset
 * @param opts - Optional search / type (comma-separated for multi) / category filters
 * @returns Paginated document list
 * @example await listDocuments(20, 0, { q: "invoice" });
 */
export async function listDocuments(
  limit = 20,
  offset = 0,
  opts?: { q?: string; document_type?: string; document_category?: string },
) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (opts?.q) params.set("q", opts.q);
  if (opts?.document_type) params.set("document_type", opts.document_type);
  if (opts?.document_category)
    params.set("document_category", opts.document_category);

  const res = await fetch(`${API_BASE}/api/documents?${params.toString()}`, {
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error || "Failed to list", res.status, body.code);
  }

  return (await res.json()) as {
    documents: import("../types").Document[];
    total: number;
    limit: number;
    offset: number;
  };
}

/**
 * Fetch a single document by id.
 * @param id - Document identifier
 * @returns Document record
 * @example await getDocument("abc-123");
 */
export async function getDocument(id: string) {
  const res = await fetch(`${API_BASE}/api/documents/${id}`, {
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));

    throw new ApiError(
      body.error || "Not found",
      res.status,
      (body as { code?: string }).code,
    );
  }
  return (await res.json()) as import("../types").Document;
}

/**
 * Re-run local extraction on a document and enqueue cloud refinement.
 * @param id - Document identifier
 * @returns Reprocess outcome
 * @example await reprocessDocument("abc-123");
 */
export async function reprocessDocument(id: string) {
  const res = await fetch(`${API_BASE}/api/documents/${id}/reprocess`, {
    method: "POST",
    credentials: "include",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));

    throw new ApiError(
      body.error || "Reprocess failed",
      res.status,
      (body as { code?: string }).code,
    );
  }
  return (await res.json()) as {
    id: string;
    status: string;
    enqueued: boolean;
    reason?: string | null;
  };
}

export async function retryDocumentRefinement(id: string) {
  const res = await fetch(
    `${API_BASE}/api/documents/${id}/refinement/retry`,
    { method: "POST", credentials: "include" },
  );
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new ApiError(
      body.error || "Refinement retry failed",
      res.status,
      body.code,
    );
  }
  return body as { id: string; status: string; enqueued: boolean };
}

async function fetchDocSub<T>(
  id: string,
  sub: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}/api/documents/${id}/${sub}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));

    throw new ApiError(
      errBody.error || "Request failed",
      res.status,
      (errBody as { code?: string }).code,
    );
  }
  return (await res.json()) as T;
}

/**
 * Fetch per-stage extraction attempts for a document.
 * @param id - Document identifier
 * @returns Attempt rows in execution order
 * @example await getAttempts("abc-123");
 */
export async function getAttempts(id: string) {
  const r = await fetchDocSub<{
    attempts: import("../types").ExtractionAttempt[];
  }>(id, "attempts");
  return r.attempts;
}

/**
 * Submit a user correction for one extracted field.
 * @param id - Document identifier
 * @param field - Field name
 * @param value - Corrected value
 * @returns Correction outcome
 * @example await submitCorrection("abc-123", "totalAmount", 1580);
 */
export async function submitCorrection(
  id: string,
  field: string,
  value: string | number,
) {
  return fetchDocSub<{
    id: string;
    field: string;
    original: unknown;
    corrected: unknown;
    changed: boolean;
  }>(id, "corrections", "POST", { field, value });
}

/**
 * List correction history for a document.
 * @param id - Document identifier
 * @returns Correction rows, newest first
 * @example await listCorrections("abc-123");
 */
export async function listCorrections(id: string) {
  const r = await fetchDocSub<{ corrections: import("../types").Correction[] }>(
    id,
    "corrections",
  );
  return r.corrections;
}
