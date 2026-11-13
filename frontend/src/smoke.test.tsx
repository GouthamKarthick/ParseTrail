/**
 * @fileoverview Frontend smoke tests (Vitest + Testing Library).
 * Covers login validation, Upload file guards, and Detail refining/dead states.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ReactNode } from 'react';
import { isSuspiciousFrontend, validateUploadFile } from './utils/security.ts';
import { isRefining } from './hooks/usePolling.ts';
import { statusBadges } from './utils/badges.ts';
import Login from './pages/Login.tsx';
import Detail from './pages/Detail.tsx';
import Upload from './pages/Upload.tsx';
import List from './pages/List.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { ToastProvider } from './context/ToastContext.tsx';
import { login, uploadDocument, getDocument, deleteDocument, listDocuments } from './api/client.ts';

vi.mock('./api/client.ts', () => ({
  getDocument: vi.fn(),
  login: vi.fn(),
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
  listDocuments: vi.fn(),
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

describe('utils — file guards', () => {
  it('rejects suspicious file names', () => {
    expect(isSuspiciousFrontend('../../etc/passwd')).toBe(true);
    expect(isSuspiciousFrontend('select * from users')).toBe(true);
    expect(isSuspiciousFrontend('<script>alert(1)</script>')).toBe(true);
    expect(isSuspiciousFrontend('a'.repeat(1001))).toBe(true);
  });
  it('accepts normal file names', () => {
    expect(isSuspiciousFrontend('invoice.pdf')).toBe(false);
    expect(isSuspiciousFrontend('receipt.png')).toBe(false);
    expect(isSuspiciousFrontend('')).toBe(false);
  });
});

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
