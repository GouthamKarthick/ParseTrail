/**
 * @fileoverview Typed HTTP client for ParseTrail backend API.
 * Wraps fetch with credential handling, error mapping via ApiError, and typed responses.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const API_BASE =
  (import.meta.env.VITE_BACKEND_URL as string) || (import.meta.env.VITE_API_URL as string) || '';

// Hard timeout on every API call so a hung backend cannot block the UI.
const API_TIMEOUT_MS = 30_000;

/**
 * Fetch with a hard request timeout.
 * @param input - Request URL
 * @param init - Fetch init (a timeout signal is merged in)
 * @returns Response
 * @throws {ApiError} with status 504 when the request times out
 */
async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ApiError('Request timed out', 504);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generic typed HTTP request helper.
 * @param method - HTTP method
 * @param path - API path (relative to API_BASE)
 * @param body - Optional JSON body
 * @returns Parsed response body of type T
 * @throws {ApiError} on non-ok responses or network errors
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(errBody.error || 'Request failed', res.status, errBody.code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

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
  password: string
) {
  return request<{
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    email_verified: boolean;
    verification_email_sent: boolean;
  }>('POST', '/api/auth/register', { first_name, last_name, email, password });
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
  return request<{ ok: boolean }>('PATCH', '/api/auth/profile', data);
}

export async function getAvatar() {
  const res = await fetchWithTimeout(`${API_BASE}/api/auth/avatar`, {
    credentials: 'include',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError('Avatar fetch failed', res.status);
  return (await res.json()) as {
    avatar_base64: string;
    mime: string;
    size_bytes: number;
  };
}

export async function putAvatar(avatar_base64: string) {
  return request<{ ok: boolean }>('PUT', '/api/auth/avatar', { avatar_base64 });
}

export async function deleteAvatar() {
  return request<{ ok: boolean }>('DELETE', '/api/auth/avatar');
}

export async function resendVerification(email: string) {
  return request<{ ok: boolean }>('POST', '/api/auth/resend-verification', { email });
}

/**
 * Authenticate an existing user.
 * @param email - User email
 * @param password - User password
 * @returns Response body on success
 * @example await login("you@example.com", "P@ssw0rd!");
 */
export async function login(email: string, password: string) {
  return request<{
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    email_verified: boolean;
  }>('POST', '/api/auth/login', { email, password });
}

/**
 * Log out the current session.
 * @returns Resolves when logout request completes
 * @example await logout();
 */
export async function logout() {
  await request<void>('POST', '/api/auth/logout');
}

/**
 * Fetch the currently authenticated user.
 * @returns User profile payload
 * @throws {ApiError} When not authenticated
 * @example const user = await me();
 */
export async function me() {
  return request<{
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    phone?: string | null;
    email_verified: number | boolean;
    created_at: string;
  }>('GET', '/api/auth/me');
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
  const qs = category ? `?category=${encodeURIComponent(category)}` : '';
  return request<{
    totalDocs: number;
    sumTotal: number;
    avgUsage: number;
    avgConfidence: number;
    byType: { document_type: string; cnt: number; sum: number }[];
    trend: { date: string; cnt: number; sum: number }[];
    topVendors: { vendor: string; cnt: number; sum: number }[];
  }>('GET', `/api/documents/summary${qs}`);
}

/**
 * Export the summary report as a downloadable blob.
 * @param format - Export file type (pdf or csv)
 * @param category - Optional category filter
 * @returns Blob for download
 * @example const blob = await exportSummary("pdf");
 */
export async function exportSummary(format: 'pdf' | 'csv' = 'pdf', category?: string) {
  const qs = category
    ? `?format=${format}&category=${encodeURIComponent(category)}`
    : `?format=${format}`;
  const res = await fetchWithTimeout(`${API_BASE}/api/documents/summary/export${qs}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error || 'Export failed', res.status);
  }
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
/**
 * Verify email via link token.
 * @param token - Verification token from email link
 * @param email - User email address
 * @returns Verification result
 * @example await verifyEmailLink(token, email);
 */
export async function verifyEmailLink(token: string, email: string) {
  return request<{ ok: boolean }>('POST', '/api/auth/verify-email', { token, email });
}

/**
 * Verify email via 6-digit code.
 * @param email - User email address
 * @param code - 6-digit verification code
 * @returns Verification result
 * @example await verifyEmailCode(email, '123456');
 */
export async function verifyEmailCode(email: string, code: string) {
  return request<{ ok: boolean }>('POST', '/api/auth/verify-email', { code, email });
}

/**
 * Request a password-reset email.
 * @param email - Account email
 * @returns Backend response body
 * @example await forgotPassword("you@example.com");
 */
export async function forgotPassword(email: string) {
  return request<{ ok: boolean }>('POST', '/api/auth/forgot-password', { email });
}

/**
 * Reset password using a one-time token.
 * @param token - Reset token from email link
 * @param password - New password
 * @returns Backend response body
 * @example await resetPassword(token, "NewP@ss1!");
 */
export async function resetPassword(token: string, password: string) {
  return request<{ ok: boolean }>('POST', '/api/auth/reset-password', { token, password });
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
  constructor(message: string, status: number, code?: string, duplicateOf?: string) {
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
export async function uploadDocument(file: File, language?: string) {
  const fd = new FormData();
  if (language) fd.append('language', language);
  fd.append('file', file);
  const res = await fetchWithTimeout(`${API_BASE}/api/documents/upload`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    throw new ApiError(body.error || 'Upload failed', res.status, body.code, body.duplicateOf);
  }
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
  opts?: { q?: string; document_type?: string; document_category?: string }
) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (opts?.q) params.set('q', opts.q);
  if (opts?.document_type) params.set('document_type', opts.document_type);
  if (opts?.document_category) params.set('document_category', opts.document_category);

  return request<{
    documents: import('../types').Document[];
    total: number;
    limit: number;
    offset: number;
  }>('GET', `/api/documents?${params.toString()}`);
}

/**
 * Fetch a single document by id.
 * @param id - Document identifier
 * @returns Document record
 * @example await getDocument("abc-123");
 */
export async function getDocument(id: string) {
  return request<import('../types').Document>('GET', `/api/documents/${id}`);
}

/**
 * Re-run local extraction on a document and enqueue cloud refinement.
 * @param id - Document identifier
 * @returns Reprocess outcome
 * @example await reprocessDocument("abc-123");
 */
export async function reprocessDocument(id: string) {
  return request<{
    id: string;
    status: string;
    enqueued: boolean;
    reason?: string | null;
  }>('POST', `/api/documents/${id}/reprocess`);
}

export async function retryDocumentRefinement(id: string) {
  return request<{ id: string; status: string; enqueued: boolean }>(
    'POST',
    `/api/documents/${id}/refinement/retry`
  );
}

/**
 * Delete a document and all its derived records.
 * @param id - Document identifier
 * @returns Void on success (204)
 * @example await deleteDocument("abc-123");
 */
export async function deleteDocument(id: string) {
  await request<void>('DELETE', `/api/documents/${id}`);
}

async function fetchDocSub<T>(id: string, sub: string, method = 'GET', body?: unknown): Promise<T> {
  return request<T>(method, `/api/documents/${id}/${sub}`, body);
}

/**
 * Fetch per-stage extraction attempts for a document.
 * @param id - Document identifier
 * @returns Attempt rows in execution order
 * @example await getAttempts("abc-123");
 */
export async function getAttempts(id: string) {
  const r = await fetchDocSub<{
    attempts: import('../types').ExtractionAttempt[];
  }>(id, 'attempts');
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
export async function submitCorrection(id: string, field: string, value: string | number) {
  return fetchDocSub<{
    id: string;
    field: string;
    original: unknown;
    corrected: unknown;
    changed: boolean;
  }>(id, 'corrections', 'POST', { field, value });
}

/**
 * List correction history for a document.
 * @param id - Document identifier
 * @returns Correction rows, newest first
 * @example await listCorrections("abc-123");
 */
export async function listCorrections(id: string) {
  const r = await fetchDocSub<{ corrections: import('../types').Correction[] }>(id, 'corrections');
  return r.corrections;
}
