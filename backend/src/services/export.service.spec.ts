import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./summary.service.js', () => ({ getSummary: vi.fn() }));
vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));

import { getSummary } from './summary.service.js';
import { pool } from '../db/pool.js';
import { generateSummaryCsv, generateDocumentsCsv } from './export.service.js';

const mockQuery = pool.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSummary).mockResolvedValue({
    totalDocs: 1,
    sumTotal: 20,
    avgUsage: 20,
    avgConfidence: 0.9,
    byType: [{ document_type: 'invoice', cnt: 1, sum: 20 }],
    trend: [{ date: '2026-11-13', cnt: 1, sum: 20 }],
    topVendors: [{ vendor: '=cmd', cnt: 1, sum: 20 }],
  });
});

describe('generateSummaryCsv', () => {
  it('neutralizes formula-leading fields and uses accurate labels', async () => {
    const csv = await generateSummaryCsv('user-1');
    expect(csv).toContain('"\'=cmd",1,"20.00"');
    expect(csv).toContain('"Average Total","20.00"');
    expect(csv).toContain('"Average Confidence","90.0%"');
    expect(csv).not.toContain('Authenticity');
    expect(csv).not.toContain('Average Usage');
  });
});

describe('generateDocumentsCsv', () => {
  function documentsRow(data: Record<string, unknown>): Record<string, unknown> {
    return {
      id: '11111111-1111-1111-1111-111111111111',
      created_at: new Date('2026-11-17T10:00:00Z'),
      status: 'done',
      document_type: 'invoice',
      document_category: 'financial',
      data: JSON.stringify(data),
    };
  }

  function mockQueries(doc: Record<string, unknown>, corrections = 0): void {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM documents')) return [[doc]];
      if (s.includes('extraction_attempts')) return [[{ document_id: doc.id, confidence: 0.95 }]];
      if (s.includes('refine_jobs')) return [[{ document_id: doc.id, status: 'done' }]];
      if (s.includes('corrections')) return [corrections > 0 ? [{ document_id: doc.id }] : []];
      return [[]];
    });
  }

  it('starts with BOM, uses CRLF, and emits the required header order', async () => {
    mockQueries(documentsRow({ vendor: 'Acme', totalAmount: 1234.56 }));
    const csv = await generateDocumentsCsv('user-1', {});
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines[0].replace(/^\uFEFF/, '')).toBe(
      'id,created_at,document_type,document_category,status,confidence,vendor,invoiceNumber,date,currency,totalAmount,corrected,refine_status'
    );
    expect(lines[1]).toContain('11111111-1111-1111-1111-111111111111');
    expect(lines[1]).toContain('done');
    expect(lines[1]).toContain('0.95');
    expect(lines[1]).toContain('no');
    expect(lines[1]).toContain('done');
  });

  it('quotes a vendor containing a comma and a quote', async () => {
    mockQueries(documentsRow({ vendor: "O'Brien, Co.", totalAmount: 10 }));
    const csv = await generateDocumentsCsv('user-1', {});
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain('"O\'Brien, Co."');
  });

  it('prefixes a vendor starting with = with a single quote (formula injection)', async () => {
    mockQueries(documentsRow({ vendor: '=cmd', totalAmount: 10 }));
    const csv = await generateDocumentsCsv('user-1', {});
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain("'=cmd");
  });

  it('includes totalAmountConverted column only when present in data', async () => {
    mockQueries(
      documentsRow({
        vendor: 'Acme',
        totalAmount: 10,
        totalAmountConverted: 850,
        currencyConverted: 'INR',
      })
    );
    const csv = await generateDocumentsCsv('user-1', {});
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('totalAmountConverted');
    expect(lines[0]).toContain('currencyConverted');
    expect(lines[1]).toContain('850');
  });

  it('omits totalAmountConverted column when absent in all data', async () => {
    mockQueries(documentsRow({ vendor: 'Acme', totalAmount: 10 }));
    const csv = await generateDocumentsCsv('user-1', {});
    const lines = csv.split('\r\n');
    expect(lines[0]).not.toContain('totalAmountConverted');
  });

  it('marks corrected=yes when the document has correction rows', async () => {
    mockQueries(documentsRow({ vendor: 'Acme', totalAmount: 10 }), 1);
    const csv = await generateDocumentsCsv('user-1', {});
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain('yes');
  });

  it('enforces user scoping (user_id in the documents query)', async () => {
    mockQueries(documentsRow({ vendor: 'Acme', totalAmount: 10 }));
    await generateDocumentsCsv('user-1', {});
    const firstCall = mockQuery.mock.calls[0][0] as string;
    expect(firstCall).toContain('user_id = ?');
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1']);
  });

  it('applies document_type filter', async () => {
    mockQueries(documentsRow({ vendor: 'Acme', totalAmount: 10 }));
    await generateDocumentsCsv('user-1', { type: 'invoice' });
    const firstCall = mockQuery.mock.calls[0][0] as string;
    expect(firstCall).toContain('document_type IN (?)');
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'invoice']);
  });

  it('uses highest seq when created_at ties in the confidence batch query', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM documents'))
        return [[documentsRow({ vendor: 'Acme', totalAmount: 10 })]];
      if (s.includes('extraction_attempts')) {
        // Same created_at, different seq; DB returns ORDER BY seq DESC so higher seq first.
        return [
          [
            {
              document_id: '11111111-1111-1111-1111-111111111111',
              confidence: 0.95,
              seq: 2,
              created_at: '2026-01-01 10:00:00',
            },
            {
              document_id: '11111111-1111-1111-1111-111111111111',
              confidence: 0.5,
              seq: 1,
              created_at: '2026-01-01 10:00:00',
            },
          ],
        ];
      }
      if (s.includes('refine_jobs'))
        return [[{ document_id: '11111111-1111-1111-1111-111111111111', status: 'done' }]];
      if (s.includes('corrections')) return [[]];
      return [[]];
    });
    const csv = await generateDocumentsCsv('user-1', {});
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain('0.95');
    const attemptsSql = mockQuery.mock.calls.find(c =>
      String(c[0]).includes('extraction_attempts')
    )![0] as string;
    expect(attemptsSql).toContain('ORDER BY seq DESC');
  });

  it('returns only the header when there are no documents', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM documents')) return [[]];
      return [[]];
    });
    const csv = await generateDocumentsCsv('user-1', {});
    const lines = csv.split('\r\n');
    expect(lines[0].replace(/^\uFEFF/, '')).toBe(
      'id,created_at,document_type,document_category,status,confidence,vendor,invoiceNumber,date,currency,totalAmount,corrected,refine_status'
    );
    expect(lines[1]).toBe('');
  });
});
