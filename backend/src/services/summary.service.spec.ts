/**
 * services/summary.service.spec.ts — aggregation with mocked pool (no DB).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));

import { pool } from '../db/pool.js';
import { getSummary, getExtractionMetrics } from './summary.service.js';

describe('services/summary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps totals and keeps the existing dashboard response shape', async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          kind: 'total',
          group_key: null,
          cnt: 2,
          sum_total: '300',
          amount_count: 2,
          avg_confidence: '0.75',
        },
        {
          kind: 'type',
          group_key: 'invoice',
          cnt: 2,
          sum_total: '300',
        },
        {
          kind: 'trend',
          group_key: '2026-10-14',
          cnt: 1,
          sum_total: '100',
        },
        {
          kind: 'vendor',
          group_key: 'V',
          cnt: 2,
          sum_total: '300',
        },
      ],
    ] as any);

    const summary = await getSummary('u1', 30);
    expect(summary).toEqual({
      totalDocs: 2,
      sumTotal: 300,
      avgUsage: 150,
      avgConfidence: 0.75,
      byType: [{ document_type: 'invoice', cnt: 2, sum: 300 }],
      trend: [{ date: '2026-10-14', cnt: 1, sum: 100 }],
      topVendors: [{ vendor: 'V', cnt: 2, sum: 300 }],
    });
  });

  it('averages only target-currency documents in a mixed-currency window', async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          kind: 'total',
          group_key: null,
          cnt: 3,
          sum_total: '300',
          amount_count: 2,
          avg_confidence: '0.5',
        },
      ],
    ] as any);

    const summary = await getSummary('u1', 30);
    expect(summary.totalDocs).toBe(3);
    expect(summary.sumTotal).toBe(300);
    expect(summary.avgUsage).toBe(summary.sumTotal / 2);
    expect(pool.query).toHaveBeenCalledOnce();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('COALESCE(currency_converted, currency) = ?'),
      ['u1', 30, 'INR']
    );
    expect(String(vi.mocked(pool.query).mock.calls[0][0])).not.toContain("= 'INR'");
  });

  it('parameterizes the optional category and handles an empty ledger', async () => {
    vi.mocked(pool.query).mockResolvedValue([
      [
        {
          kind: 'total',
          group_key: null,
          cnt: 0,
          sum_total: '0',
          amount_count: 0,
          avg_confidence: '0',
        },
      ],
    ] as any);

    const summary = await getSummary('u1', 30, { category: 'financial' });
    expect(summary.avgConfidence).toBe(0);
    expect(summary.avgUsage).toBe(0);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('AND document_category = ?'), [
      'u1',
      30,
      'financial',
      'INR',
    ]);
  });

  describe('getExtractionMetrics', () => {
    it('computes local-only %, cloud calls, tokens and needs-review count', async () => {
      const mockQuery = vi.mocked(pool.query) as any;
      mockQuery.mockImplementation(async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('COUNT(*) AS cnt FROM documents') && !s.includes('reviewed_at'))
          return [[{ cnt: 10 }]];
        if (s.includes("ea.method = 'llm'"))
          return [[{ cloudCalls: 3, totalTokens: '4120', docsWithCloud: 4 }]];
        // needs-review count query: per-document data + reviewed_at + refine_status + confidence
        if (s.includes('d.data') && s.includes('refine_jobs r WHERE r.document_id = d.id'))
          return [
            [
              {
                data: JSON.stringify({ vendor: 'A', invoiceDate: '2026-01-01', totalAmount: 10 }),
                reviewed_at: null,
                refine_status: null,
                confidence: 0.9,
              },
              {
                data: JSON.stringify({ vendor: 'A', invoiceDate: '2026-01-01', totalAmount: 10 }),
                reviewed_at: null,
                refine_status: null,
                confidence: 0.5,
              },
              {
                data: JSON.stringify({ vendor: 'A', invoiceDate: '2026-01-01', totalAmount: 10 }),
                reviewed_at: '2026-01-02',
                refine_status: null,
                confidence: 0.9,
              },
              {
                data: JSON.stringify({ invoiceDate: '2026-01-01', totalAmount: 10 }),
                reviewed_at: null,
                refine_status: null,
                confidence: 0.9,
              },
            ],
          ];
        return [[]];
      });

      const metrics = await getExtractionMetrics('u1', 30);
      expect(metrics).toEqual({
        localOnlyPercent: 60, // (10 - 4) / 10 * 100
        cloudCalls: 3,
        totalTokens: 4120,
        needsReviewCount: 2, // low-confidence doc + missing-vendor doc
      });
      // needs-review query must not depend on days: only userId is passed
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY d.created_at DESC'),
        ['u1']
      );
    });

    it('with days=7 still counts an older unapproved document that needs review', async () => {
      const mockQuery = vi.mocked(pool.query) as any;
      mockQuery.mockImplementation(async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('COUNT(*) AS cnt FROM documents') && !s.includes('reviewed_at'))
          return [[{ cnt: 2 }]];
        if (s.includes("ea.method = 'llm'"))
          return [[{ cloudCalls: 0, totalTokens: 0, docsWithCloud: 0 }]];
        // needs-review count query: per-document data + reviewed_at + refine_status + confidence
        if (s.includes('d.data') && s.includes('refine_jobs r WHERE r.document_id = d.id'))
          return [
            [
              // older doc (outside any days window) that still needs review
              {
                data: JSON.stringify({ invoiceDate: '2025-01-01', totalAmount: 10 }),
                reviewed_at: null,
                refine_status: null,
                confidence: 0.9,
              },
              // approved doc -> not needs review
              {
                data: JSON.stringify({ vendor: 'A', invoiceDate: '2026-01-01', totalAmount: 10 }),
                reviewed_at: '2026-01-02',
                refine_status: null,
                confidence: 0.5,
              },
            ],
          ];
        return [[]];
      });

      const metrics = await getExtractionMetrics('u1', 7);
      expect(metrics.localOnlyPercent).toBe(100); // (2 - 0) / 2 * 100
      expect(metrics.cloudCalls).toBe(0);
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.needsReviewCount).toBe(1); // older unapproved doc still counts
      // needs-review query must not depend on days: only userId is passed
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY d.created_at DESC'),
        ['u1']
      );
    });

    it('counts needs-review via needsReview() rule (alerts: only dup/future-date force)', async () => {
      const mockQuery = vi.mocked(pool.query) as any;
      mockQuery.mockImplementation(async (sql: unknown) => {
        const s = String(sql);
        if (s.includes('COUNT(*) AS cnt FROM documents') && !s.includes('reviewed_at'))
          return [[{ cnt: 2 }]];
        if (s.includes("ea.method = 'llm'"))
          return [[{ cloudCalls: 0, totalTokens: 0, docsWithCloud: 0 }]];
        if (s.includes('d.data') && s.includes('refine_jobs r WHERE r.document_id = d.id'))
          return [
            [
              // approved -> not needs review
              {
                data: JSON.stringify({ vendor: 'A', invoiceDate: '2026-01-01', totalAmount: 10 }),
                reviewed_at: '2026-01-02',
                refine_status: null,
                confidence: 0.5,
              },
              // amount spike alone does NOT force review
              {
                data: JSON.stringify({
                  vendor: 'A',
                  invoiceDate: '2026-01-01',
                  totalAmount: 10,
                  alerts: [{ code: 'AMOUNT_SPIKE', message: 'x' }],
                }),
                reviewed_at: null,
                refine_status: null,
                confidence: 0.9,
              },
            ],
          ];
        return [[]];
      });

      const metrics = await getExtractionMetrics('u1', 30);
      expect(metrics.needsReviewCount).toBe(0);
    });

    it('returns zeros when there are no documents', async () => {
      vi.mocked(pool.query).mockResolvedValue([[]] as any);
      const metrics = await getExtractionMetrics('u1', 30);
      expect(metrics.localOnlyPercent).toBe(0);
      expect(metrics.cloudCalls).toBe(0);
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.needsReviewCount).toBe(0);
    });
  });
});
