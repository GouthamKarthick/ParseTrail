import { describe, it, expect } from 'vitest';
import { needsReview } from './review.js';

describe('needsReview', () => {
  const base = {
    confidence: 0.9,
    data: { vendor: 'Acme', invoiceDate: '2026-01-01', totalAmount: 10 },
    refine_status: null,
  };

  it('returns false when reviewed_at is set (approved)', () => {
    expect(needsReview({ ...base, reviewed_at: new Date() })).toBe(false);
    expect(needsReview({ ...base, reviewed_at: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  it('returns true when confidence < 0.8', () => {
    expect(needsReview({ ...base, reviewed_at: null, confidence: 0.79 })).toBe(true);
    expect(needsReview({ ...base, reviewed_at: null, confidence: 0 })).toBe(true);
  });

  it('returns false when confidence is exactly 0.8', () => {
    expect(needsReview({ ...base, reviewed_at: null, confidence: 0.8 })).toBe(false);
  });

  it('returns true when vendor is missing', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: { invoiceDate: '2026-01-01', totalAmount: 10 },
      })
    ).toBe(true);
  });

  it('returns true when vendor is empty', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: { vendor: '   ', invoiceDate: '2026-01-01', totalAmount: 10 },
      })
    ).toBe(true);
  });

  it('returns true when date is missing', () => {
    expect(
      needsReview({ ...base, reviewed_at: null, data: { vendor: 'Acme', totalAmount: 10 } })
    ).toBe(true);
  });

  it('returns true when date is empty', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: { vendor: 'Acme', invoiceDate: '', totalAmount: 10 },
      })
    ).toBe(true);
  });

  it('returns true when totalAmount is missing', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: { vendor: 'Acme', invoiceDate: '2026-01-01' },
      })
    ).toBe(true);
  });

  it('returns true when totalAmount is empty', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: { vendor: 'Acme', invoiceDate: '2026-01-01', totalAmount: '' },
      })
    ).toBe(true);
  });

  it('returns true when refine_status is dead', () => {
    expect(needsReview({ ...base, reviewed_at: null, refine_status: 'dead' })).toBe(true);
  });

  it('returns false when everything is present and not approved', () => {
    expect(needsReview({ ...base, reviewed_at: null })).toBe(false);
  });

  it('returns true when data has a POSSIBLE_DUPLICATE alert', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: {
          vendor: 'Acme',
          invoiceDate: '2026-01-01',
          totalAmount: 10,
          alerts: [{ code: 'POSSIBLE_DUPLICATE', message: 'x' }],
        },
      })
    ).toBe(true);
  });

  it('returns true when data has a FUTURE_DATE alert', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: {
          vendor: 'Acme',
          invoiceDate: '2026-01-01',
          totalAmount: 10,
          alerts: [{ code: 'FUTURE_DATE', message: 'x' }],
        },
      })
    ).toBe(true);
  });

  it('returns true when data has a FUTURE_DATE alert even at high confidence', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        confidence: 0.99,
        data: {
          vendor: 'Acme',
          invoiceDate: '2026-01-01',
          totalAmount: 10,
          alerts: [{ code: 'FUTURE_DATE', message: 'x' }],
        },
      })
    ).toBe(true);
  });

  it('returns false when data only has an AMOUNT_SPIKE alert', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        confidence: 0.99,
        data: {
          vendor: 'Acme',
          invoiceDate: '2026-01-01',
          totalAmount: 10,
          alerts: [{ code: 'AMOUNT_SPIKE', message: 'x' }],
        },
      })
    ).toBe(false);
  });

  it('returns false when data only has a PAYSLIP_SHIFT alert', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        confidence: 0.99,
        data: {
          vendor: 'Acme',
          invoiceDate: '2026-01-01',
          totalAmount: 10,
          alerts: [{ code: 'PAYSLIP_SHIFT', message: 'x' }],
        },
      })
    ).toBe(false);
  });

  it('returns false when alerts is empty', () => {
    expect(
      needsReview({
        ...base,
        reviewed_at: null,
        data: { vendor: 'Acme', invoiceDate: '2026-01-01', totalAmount: 10, alerts: [] },
      })
    ).toBe(false);
  });
});
