/**
 * @fileoverview Frontend smoke tests (Vitest + Testing Library).
 * Covers login validation, Upload file guards, and Detail refining/dead states.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ReactNode } from 'react';
import { validateUploadFile, getPasswordError } from './utils/security.ts';
import { isRefining } from './hooks/usePolling.ts';
import { statusBadges } from './utils/badges.ts';
import Login from './pages/Login.tsx';
import Detail from './pages/Detail.tsx';
import Upload from './pages/Upload.tsx';
import List from './pages/List.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { ToastProvider } from './context/ToastContext.tsx';
import {
  login,
  uploadDocument,
  getDocument,
  deleteDocument,
  listDocuments,
  exportDocuments,
  getDocumentFileBlob,
  approveDocument,
} from './api/client.ts';

const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal) {
      const rest = { ...init };
      delete rest.signal;
      super(input, rest);
    } else {
      super(input, init);
    }
  }
} as typeof Request;

vi.mock('./api/client.ts', () => ({
  getDocument: vi.fn(),
  login: vi.fn(),
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
  listDocuments: vi.fn(),
  exportDocuments: vi.fn().mockResolvedValue(new Blob(['id,name\n'])),
  getDocumentFileBlob: vi.fn().mockResolvedValue(null),
  approveDocument: vi
    .fn()
    .mockResolvedValue({ id: 'd1', needs_review: false, reviewed_at: '2026-01-02T00:00:00Z' }),
  me: vi.fn().mockResolvedValue({
    id: 'u1',
    email: 'user@example.com',
    first_name: 'User',
    last_name: 'One',
    email_verified: true,
  } as any),
  getAttempts: vi.fn().mockResolvedValue([]),
  listCorrections: vi.fn().mockResolvedValue([]),
  retryDocumentRefinement: vi.fn().mockResolvedValue({}),
}));

const mockLogin = vi.mocked(login);
const mockUpload = vi.mocked(uploadDocument);
const mockGetDocument = vi.mocked(getDocument);
const mockDeleteDocument = vi.mocked(deleteDocument);
const mockListDocuments = vi.mocked(listDocuments);
const mockExportDocuments = vi.mocked(exportDocuments);
const mockGetDocumentFileBlob = vi.mocked(getDocumentFileBlob);
const mockApproveDocument = vi.mocked(approveDocument);

function providers(children: ReactNode) {
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}

function renderAt(route: string, ui: React.ReactNode) {
  const router = createMemoryRouter(
    [
      { path: '/', element: providers(ui) },
      { path: '/documents/:id', element: providers(ui) },
      { path: '*', element: providers(ui) },
    ],
    { initialEntries: [route] }
  );
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

describe('utils — refine status', () => {
  it('isRefining true while queued or working', () => {
    expect(isRefining({ status: 'done', refine_status: 'queued' } as any)).toBe(true);
    expect(isRefining({ status: 'done', refine_status: 'working' } as any)).toBe(true);
    expect(isRefining({ status: 'done', refine_status: null } as any)).toBe(false);
    expect(isRefining({ status: 'done', refine_status: 'done' } as any)).toBe(false);
  });
});

describe('utils — status badges (Detail display logic)', () => {
  it('refining -> Enhancing with AI', () => {
    expect(statusBadges('done', 'working')).toContainEqual({
      variant: 'info',
      label: 'Enhancing with AI',
    });
  });
  it('dead -> Ready + AI enhancement unavailable', () => {
    const badges = statusBadges('done', 'dead');
    expect(badges.map(b => b.label)).toContain('Ready');
    expect(badges.map(b => b.label)).toContain('AI enhancement unavailable');
  });
  it('processing -> Processing', () => {
    expect(statusBadges('processing', null)).toContainEqual({
      variant: 'warning',
      label: 'Processing',
    });
  });
});

// ---------------------------------------------------------------------------
// Upload — client-side validation and lifecycle states
// ---------------------------------------------------------------------------

describe('utils — upload file validation', () => {
  it('rejects oversize files', () => {
    const file = new File(['x'.repeat(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' });
    expect(validateUploadFile(file)).toContain('10 MB');
  });
  it('rejects wrong file type', () => {
    const file = new File(['x'], 'script.exe', {
      type: 'application/x-msdownload',
    });
    expect(validateUploadFile(file)).toContain('Invalid file type');
  });
  it('accepts valid PDF', () => {
    const file = new File(['%PDF-1.4'], 'doc.pdf', {
      type: 'application/pdf',
    });
    expect(validateUploadFile(file)).toBe(null);
  });
  it('accepts valid PNG', () => {
    const file = new File([new Uint8Array([0x89, 0x50])], 'img.png', {
      type: 'image/png',
    });
    expect(validateUploadFile(file)).toBe(null);
  });
});

describe('Upload page', () => {
  it('rejects oversize file with inline message before submit', () => {
    mockUpload.mockResolvedValue({
      id: 'd1',
      name: 'big.pdf',
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    } as any);

    const { container } = renderAt('/', <Upload />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'.repeat(11 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText(/10 MB/i)).toBeTruthy();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects wrong file type with inline message before submit', () => {
    mockUpload.mockResolvedValue({
      id: 'd1',
      name: 'script.exe',
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    } as any);

    const { container } = renderAt('/', <Upload />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'script.exe', {
      type: 'application/x-msdownload',
    });
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText(/Invalid file type/i)).toBeTruthy();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('shows queued state after 202 instead of silence', async () => {
    mockUpload.mockResolvedValue({
      id: 'd1',
      name: 'invoice.pdf',
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    } as any);

    const { container } = renderAt('/', <Upload />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'invoice.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(input, { target: { files: [file] } });

    const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    fireEvent.click(submitBtn);

    await vi.waitFor(() => expect(mockUpload).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Extracting…' })).toBeTruthy()
    );
    expect(screen.getByRole('button', { name: /view document/i })).toBeTruthy();
  });

  it('uploads three files sequentially in order', async () => {
    mockUpload.mockClear();
    mockUpload.mockResolvedValue({
      id: 'd1',
      name: 'a.pdf',
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    } as any);

    const { container } = renderAt('/', <Upload />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
      new File(['c'], 'c.pdf', { type: 'application/pdf' }),
    ];
    fireEvent.change(input, { target: { files } });

    await userEvent.click(screen.getByRole('button', { name: /Upload/i }));

    await vi.waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(3));
    expect(mockUpload.mock.calls[0][0].name).toBe('a.pdf');
    expect(mockUpload.mock.calls[1][0].name).toBe('b.pdf');
    expect(mockUpload.mock.calls[2][0].name).toBe('c.pdf');
  });

  it('skips one invalid file and uploads the rest', async () => {
    mockUpload.mockClear();
    mockUpload.mockResolvedValue({
      id: 'd1',
      name: 'ok.pdf',
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    } as any);

    const { container } = renderAt('/', <Upload />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(['a'], 'ok.pdf', { type: 'application/pdf' }),
      new File(['x'], 'script.exe', { type: 'application/x-msdownload' }),
    ];
    fireEvent.change(input, { target: { files } });

    await userEvent.click(screen.getByRole('button', { name: /Upload/i }));

    await vi.waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockUpload.mock.calls[0][0].name).toBe('ok.pdf');
    expect(screen.getByText(/^Skipped$/)).toBeTruthy();
  });

  it('shows a 409 response as duplicate, not failure', async () => {
    mockUpload.mockClear();
    mockUpload.mockRejectedValueOnce({
      status: 409,
      code: 'DUPLICATE_CONTENT',
      message: 'Duplicate document — already exists',
      duplicateOf: 'dup-id',
    } as any);

    const { container } = renderAt('/', <Upload />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['a'], 'dup.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await userEvent.click(screen.getByRole('button', { name: /Upload/i }));

    await vi.waitFor(() => expect(screen.getByText(/^Duplicate$/)).toBeTruthy());
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('stops the queue on 429 and marks remaining not sent', async () => {
    mockUpload.mockClear();
    mockUpload
      .mockResolvedValueOnce({
        id: 'd1',
        name: 'a.pdf',
        status: 'pending',
        created_at: '2026-01-01T00:00:00Z',
      } as any)
      .mockRejectedValueOnce({
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests',
      } as any);

    const { container } = renderAt('/', <Upload />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
      new File(['c'], 'c.pdf', { type: 'application/pdf' }),
    ];
    fireEvent.change(input, { target: { files } });

    await userEvent.click(screen.getByRole('button', { name: /Upload/i }));

    await vi.waitFor(() =>
      expect(screen.getByText(/Too many uploads, try again in a minute/i)).toBeTruthy()
    );
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/^Not sent$/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// List — delete dialog flow
// ---------------------------------------------------------------------------

describe('List page', () => {
  beforeEach(() => {
    mockListDocuments.mockResolvedValue({
      documents: [
        {
          id: 'd1',
          name: 'invoice.pdf',
          status: 'done',
          document_type: 'invoice',
          document_category: 'financial',
          data: { vendor: 'Acme', totalAmount: 100, currency: 'USD' },
          error: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        } as any,
        {
          id: 'd2',
          name: 'receipt.pdf',
          status: 'done',
          document_type: 'receipt',
          document_category: 'financial',
          data: { vendor: 'Best Shop', totalAmount: 50, currency: 'USD' },
          error: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        } as any,
      ],
      total: 2,
      limit: 20,
      offset: 0,
    } as any);
  });

  it('clicking row Delete shows the confirm dialog', async () => {
    renderAt('/', <List />);

    // Wait for documents to load
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeTruthy());

    // First Delete click should open the dialog (not call deleteDocument)
    const firstDelete = screen.getAllByRole('button', { name: /^Delete$/ })[0];
    await userEvent.click(firstDelete);

    // Dialog should be open
    await waitFor(() => expect(screen.getByText(/Delete document\?/i)).toBeTruthy());
    // cancel should not call deleteDocument
    await userEvent.click(screen.getByText('Cancel').closest('button') as HTMLElement);
    expect(mockDeleteDocument).not.toHaveBeenCalled();
  });

  it('confirming delete calls deleteDocument and removes the row', async () => {
    mockDeleteDocument.mockResolvedValue(undefined);

    renderAt('/', <List />);

    // Wait for documents to load
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeTruthy());

    // Open dialog
    const firstDelete = screen.getAllByRole('button', { name: /^Delete$/ })[0];
    await userEvent.click(firstDelete);
    await waitFor(() => expect(screen.getByText(/Delete document\?/)).toBeTruthy());

    // Confirm - click the Delete button inside the dialog
    const dialogEl = screen.getByText(/Delete document\?/).closest('dialog') as HTMLElement;
    const dialogButtons = dialogEl.querySelectorAll('button');
    await userEvent.click(dialogButtons[1]);
    await vi.waitFor(() => expect(mockDeleteDocument).toHaveBeenCalledWith('d1'));
  });

  it('Export CSV button renders and calls the endpoint with current filters', async () => {
    renderAt('/', <List />);
    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
    await vi.waitFor(() => expect(mockExportDocuments).toHaveBeenCalled());
  });

  it('Needs review badge shows when needs_review is true', async () => {
    mockListDocuments.mockResolvedValue({
      documents: [
        {
          id: 'd1',
          name: 'invoice.pdf',
          status: 'done',
          document_type: 'invoice',
          document_category: 'financial',
          data: { vendor: 'Acme', totalAmount: 100, currency: 'USD' },
          needs_review: true,
          refine_status: null,
          error: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        } as any,
      ],
      total: 1,
      limit: 20,
      offset: 0,
    } as any);

    renderAt('/', <List />);

    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeTruthy());
    expect(screen.getAllByText(/Needs review/i)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Detail — mounting smoke test (state labels covered by statusBadges above)
// ---------------------------------------------------------------------------

describe('Detail page', () => {
  it('mounts within the router and shows Loading… until data resolves', () => {
    mockGetDocument.mockImplementation(() => Promise.resolve(null as any));

    renderAt('/documents/doc-1', <Detail />);
    screen.getByText(/loading…/i);
  });

  it('shows Queued for pending status', async () => {
    mockGetDocument.mockImplementation(() =>
      Promise.resolve({
        id: 'd1',
        name: 'pending.pdf',
        status: 'pending',
        document_type: 'unknown',
        document_category: 'unknown',
        data: null,
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      } as any)
    );

    renderAt('/documents/d1', <Detail />);

    await vi.waitFor(() => expect(screen.getAllByText(/Queued/i).length).toBeGreaterThan(0));
  });

  it('shows Extracting… for processing status', async () => {
    mockGetDocument.mockImplementation(() =>
      Promise.resolve({
        id: 'd1',
        name: 'processing.pdf',
        status: 'processing',
        document_type: 'unknown',
        document_category: 'unknown',
        data: null,
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      } as any)
    );

    renderAt('/documents/d1', <Detail />);

    await vi.waitFor(() => expect(screen.getByText(/Extracting…/i)).toBeTruthy());
  });

  it('shows Improving with cloud AI… when refining', async () => {
    mockGetDocument.mockImplementation(() =>
      Promise.resolve({
        id: 'd1',
        name: 'refining.pdf',
        status: 'done',
        document_type: 'invoice',
        document_category: 'financial',
        data: { vendor: 'Acme', totalAmount: 100 },
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        refine_status: 'working',
      } as any)
    );

    renderAt('/documents/d1', <Detail />);

    await vi.waitFor(() => expect(screen.getByText(/Improving with cloud AI…/i)).toBeTruthy());
  });

  it('dead state shows Retry AI, Upload clearer file, and Correct fields manually', async () => {
    mockGetDocument.mockImplementation(() =>
      Promise.resolve({
        id: 'd1',
        name: 'dead.pdf',
        status: 'done',
        document_type: 'invoice',
        document_category: 'financial',
        data: { vendor: 'Acme', totalAmount: 100, currency: 'USD' },
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        refine_status: 'dead',
        refine_error: 'provider quota exceeded',
      } as any)
    );

    renderAt('/documents/d1', <Detail />);

    await vi.waitFor(() => expect(screen.getAllByText(/Retry AI/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/Upload a clearer file/i)).toBeTruthy();
    expect(screen.getByText(/Correct fields manually/i)).toBeTruthy();
    expect(screen.getByText(/provider quota exceeded/i)).toBeTruthy();
  });

  it('shows the original file preview for an image doc', async () => {
    mockGetDocument.mockImplementation(() =>
      Promise.resolve({
        id: 'd1',
        name: 'receipt.png',
        status: 'done',
        document_type: 'receipt',
        document_category: 'financial',
        data: { vendor: 'Acme', totalAmount: 10, currency: 'USD' },
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      } as any)
    );
    mockGetDocumentFileBlob.mockResolvedValue(new Blob(['fake-png'], { type: 'image/png' }));

    // jsdom in this vitest setup lacks URL.createObjectURL; real browsers have it.
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    (URL as any).createObjectURL = () => 'mocked-object-url';
    (URL as any).revokeObjectURL = () => {};

    renderAt('/documents/d1', <Detail />);

    await vi.waitFor(() => expect(screen.getByRole('img')).toBeTruthy());
    expect(mockGetDocumentFileBlob).toHaveBeenCalledWith('d1');

    (URL as any).createObjectURL = origCreate ?? (() => {});
    (URL as any).revokeObjectURL = origRevoke ?? (() => {});
  });

  it('shows the muted fallback when the original file is unavailable (404)', async () => {
    mockGetDocument.mockImplementation(() =>
      Promise.resolve({
        id: 'd1',
        name: 'invoice.pdf',
        status: 'done',
        document_type: 'invoice',
        document_category: 'financial',
        data: { vendor: 'Acme', totalAmount: 10, currency: 'USD' },
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      } as any)
    );
    mockGetDocumentFileBlob.mockResolvedValue(null);

    renderAt('/documents/d1', <Detail />);

    await vi.waitFor(() =>
      expect(screen.getByText(/Original file is no longer available/i)).toBeTruthy()
    );
  });

  it('Approve calls the endpoint and the needs-review banner disappears', async () => {
    mockGetDocument.mockImplementation(() =>
      Promise.resolve({
        id: 'd1',
        name: 'invoice.pdf',
        status: 'done',
        document_type: 'invoice',
        document_category: 'financial',
        data: { vendor: 'Acme', totalAmount: 10, currency: 'USD' },
        needs_review: true,
        reviewed_at: null,
        refine_status: null,
        error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      } as any)
    );
    mockApproveDocument.mockResolvedValue({
      id: 'd1',
      needs_review: false,
      reviewed_at: '2026-01-02T00:00:00Z',
    });

    renderAt('/documents/d1', <Detail />);

    await vi.waitFor(() =>
      expect(screen.getByText(/Needs review: check the highlighted fields/i)).toBeTruthy()
    );
    await userEvent.click(screen.getByRole('button', { name: /Approve/i }));
    await vi.waitFor(() => expect(mockApproveDocument).toHaveBeenCalledWith('d1'));
    await vi.waitFor(() =>
      expect(screen.queryByText(/Needs review: check the highlighted fields/i)).toBeNull()
    );
    expect(screen.getByText(/1\/2\/2026/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe('Login page', () => {
  it('renders and calls login on submit', async () => {
    mockLogin.mockResolvedValue({
      id: 'u1',
      email: 'user@example.com',
      first_name: 'User',
      last_name: 'One',
      email_verified: true,
    } as any);

    renderAt('/login', <Login />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'Password1!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /login/i }));

    await vi.waitFor(() =>
      expect(mockLogin).toHaveBeenCalledWith('user@example.com', 'Password1!')
    );
  });

  it('shows an error when login fails', async () => {
    mockLogin.mockRejectedValue(new Error('Invalid credentials'));

    renderAt('/login', <Login />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: /login/i }));

    await vi.waitFor(() =>
      // getByText throws if the element is absent, so this asserts presence.
      expect(screen.getByText(/invalid credentials/i)).toBeTruthy()
    );
  });
});

describe('utils — password policy (72 byte bcrypt limit)', () => {
  const over72 = 'A'.repeat(80); // 80 bytes > bcrypt 72-byte limit
  const exactly72 = 'A' + '1' + '!' + 'B'.repeat(69); // 72 bytes, valid complexity
  const over72valid = 'A' + '1' + '!' + 'B'.repeat(70); // 73 bytes, valid complexity

  it('rejects a password over 72 bytes', () => {
    expect(getPasswordError(over72)).toContain('72 bytes');
    expect(getPasswordError(over72valid)).toContain('72 bytes');
  });

  it('accepts a password of exactly 72 bytes with valid complexity', () => {
    expect(getPasswordError(exactly72)).toBeNull();
  });

  it('still enforces complexity on long-enough passwords', () => {
    expect(getPasswordError('weakpassword')).toContain('uppercase');
    expect(getPasswordError('NoNumbers!')).toContain('number');
    expect(getPasswordError('NoSpecial1')).toContain('special');
    expect(getPasswordError('short1!')).toContain('at least 8 characters');
  });
});
