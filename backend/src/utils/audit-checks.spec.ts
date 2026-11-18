import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool.js';
import { checkDocumentAlerts } from './audit-checks.js';

const mockQuery = vi.mocked(pool.query) as any;

function row(data: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'other',
    data: JSON.stringify(data),
    invoiceDate: '2026-01-05',
    created_at: '2026-01-05T00:00:00Z',
  };
}

describe('utils/audit-checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when no alerts', async () => {
    mockQuery.mockResolvedValue([[]] as any);
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-01-01',
        totalAmount: 100,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts).toEqual([]);
  });

  it('flags exact content duplicate from findDuplicateByContent', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('content_fingerprint')) {
        return [
          [
            {
              id: 'dup-id',
              data: JSON.stringify({
                vendor: 'acme',
                invoiceNumber: 'INV-1',
                totalAmount: 100,
                currency: 'inr',
              }),
              document_type: 'invoice',
              document_category: 'financial',
            },
          ],
        ];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'inv-1',
        invoiceDate: '2026-01-01',
        totalAmount: 100,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts.some(a => a.code === 'POSSIBLE_DUPLICATE')).toBe(true);
    expect(alerts[0].relatedDocId).toBe('dup-id');
  });

  it('flags loose same-vendor-same-amount duplicate within 14 days', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('DATE_SUB(NOW(), INTERVAL 14 DAY)')) {
        return [
          [row({ vendor: 'Acme', invoiceNumber: 'INV/104', totalAmount: 100, currency: 'INR' })],
        ];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-104',
        invoiceDate: '2026-01-10',
        totalAmount: 100,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts.some(a => a.code === 'POSSIBLE_DUPLICATE')).toBe(true);
  });

  it('flags amount spike >30% over historical average', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('LIMIT 50') && s.includes('data IS NOT NULL')) {
        return [
          [
            row({ vendor: 'Acme', totalAmount: 100 }),
            row({ vendor: 'Acme', totalAmount: 100 }),
            row({ vendor: 'Acme', totalAmount: 100 }),
          ],
        ];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-01-01',
        totalAmount: 200,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts.some(a => a.code === 'AMOUNT_SPIKE')).toBe(true);
    expect(alerts[0].message).toContain('100%');
  });

  it('does not flag amount spike within 30%', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('LIMIT 50') && s.includes('data IS NOT NULL')) {
        return [
          [row({ vendor: 'Acme', totalAmount: 100 }), row({ vendor: 'Acme', totalAmount: 100 })],
        ];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-01-01',
        totalAmount: 120,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts.some(a => a.code === 'AMOUNT_SPIKE')).toBe(false);
  });

  it('flags payslip net-pay shift >5%', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("document_type='payslip'")) {
        return [[row({ vendor: 'Acme Corp', totalAmount: 50000 })]];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'acme corp',
        invoiceNumber: 'P-1',
        invoiceDate: '2026-01-01',
        totalAmount: 46000,
        currency: 'INR',
      } as any,
      'u1',
      'payslip',
      'self'
    );
    expect(alerts.some(a => a.code === 'PAYSLIP_SHIFT')).toBe(true);
    expect(alerts[0].message).toContain('-8.0%');
  });

  it('flags future invoice date >7 days ahead', async () => {
    mockQuery.mockResolvedValue([[]] as any);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-1',
        invoiceDate: future,
        totalAmount: 100,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts.some(a => a.code === 'FUTURE_DATE')).toBe(true);
  });

  it('does not flag date within 7 days', async () => {
    mockQuery.mockResolvedValue([[]] as any);
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-1',
        invoiceDate: soon,
        totalAmount: 100,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts.some(a => a.code === 'FUTURE_DATE')).toBe(false);
  });

  it('does not double-fire POSSIBLE_DUPLICATE when exact dup already matched', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('content_fingerprint')) {
        return [
          [
            {
              id: 'dup-id',
              data: JSON.stringify({
                vendor: 'acme',
                invoiceNumber: 'INV-1',
                totalAmount: 100,
                currency: 'inr',
              }),
              document_type: 'invoice',
              document_category: 'financial',
            },
          ],
        ];
      }
      if (s.includes('DATE_SUB(NOW(), INTERVAL 14 DAY)')) {
        return [
          [
            {
              id: 'dup-id',
              data: JSON.stringify({
                vendor: 'Acme',
                invoiceNumber: 'INV/1',
                totalAmount: 100,
                currency: 'INR',
              }),
              created_at: '2026-01-10T00:00:00Z',
            },
          ],
        ];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-01-10',
        totalAmount: 100,
        currency: 'INR',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    const dups = alerts.filter(a => a.code === 'POSSIBLE_DUPLICATE');
    expect(dups.length).toBe(1);
    expect(dups[0].relatedDocId).toBe('dup-id');
  });

  it('skips cross-currency rows for amount spike', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('LIMIT 50') && s.includes('data IS NOT NULL')) {
        return [
          [
            row({ vendor: 'Acme', totalAmount: 100, currency: 'INR' }),
            row({ vendor: 'Acme', totalAmount: 100, currency: 'INR' }),
            row({ vendor: 'Acme', totalAmount: 100, currency: 'INR' }),
          ],
        ];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'Acme',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-01-01',
        totalAmount: 200,
        currency: 'USD',
      } as any,
      'u1',
      'invoice',
      'self'
    );
    expect(alerts.some(a => a.code === 'AMOUNT_SPIKE')).toBe(false);
  });

  it('skips cross-currency rows for payslip shift', async () => {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("document_type='payslip'")) {
        return [[row({ vendor: 'Acme Corp', totalAmount: 50000, currency: 'INR' })]];
      }
      return [[]];
    });
    const alerts = await checkDocumentAlerts(
      {
        vendor: 'acme corp',
        invoiceNumber: 'P-1',
        invoiceDate: '2026-01-01',
        totalAmount: 46000,
        currency: 'USD',
      } as any,
      'u1',
      'payslip',
      'self'
    );
    expect(alerts.some(a => a.code === 'PAYSLIP_SHIFT')).toBe(false);
  });
});
