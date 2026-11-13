import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./summary.service.js', () => ({ getSummary: vi.fn() }));

import { getSummary } from './summary.service.js';
import { generateSummaryCsv } from './export.service.js';

describe('generateSummaryCsv', () => {
  beforeEach(() => {
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

  it('neutralizes formula-leading fields and uses accurate labels', async () => {
    const csv = await generateSummaryCsv('user-1');
    expect(csv).toContain('"\'=cmd",1,"20.00"');
    expect(csv).toContain('"Average Total","20.00"');
    expect(csv).toContain('"Average Confidence","90.0%"');
    expect(csv).not.toContain('Authenticity');
    expect(csv).not.toContain('Average Usage');
  });
});
