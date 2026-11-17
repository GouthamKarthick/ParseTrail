import { describe, it, expect } from 'vitest';
import {
  getDocumentTypeStrategy,
  buildCloudPrompt,
  buildCloudExtractionPrompt,
  buildLocalModelPrompt,
  DOCUMENT_TYPE_FOCUS,
} from './strategies.js';
import { FINANCIAL_BASE_PROMPT } from '../prompts/financial.js';
import { getPromptForType } from './registry.js';
import type { DocumentType } from '../types/index.js';

describe('strategies — per-type prompts and examples', () => {
  it('invoice returns the base prompt verbatim', () => {
    expect(buildCloudPrompt('invoice')).toBe(FINANCIAL_BASE_PROMPT);
    expect(getPromptForType('invoice')).toBe(FINANCIAL_BASE_PROMPT);
  });
  it('unknown types fall back to generic behavior', () => {
    expect(buildCloudPrompt('other')).toBe(FINANCIAL_BASE_PROMPT);
    expect(buildCloudPrompt('whatever')).toBe(FINANCIAL_BASE_PROMPT);
    expect(getDocumentTypeStrategy('whatever').localExample.json).toContain('INV-123');
  });
  it('each financial type carries a focus line and a valid example', () => {
    for (const t of ['receipt', 'payment', 'bill', 'payslip', 'settlement_slip']) {
      const s = getDocumentTypeStrategy(t);
      expect(s.cloudPromptFocus.length).toBeGreaterThan(20);
      expect(() => JSON.parse(s.localExample.json)).not.toThrow();
      expect(buildCloudPrompt(t)).toContain('Focus:');
      expect(buildCloudPrompt(t)).toContain('Return ONLY valid JSON');
    }
  });
  it('registry routes prompts through strategies', () => {
    expect(getPromptForType('bill')).toContain('utility');
    expect(getPromptForType('payslip')).toContain('NET PAY');
  });

  it('buildCloudExtractionPrompt includes base prompt + type focus', () => {
    const prompt = buildCloudExtractionPrompt({ predictedType: 'receipt' });
    expect(prompt).toContain(FINANCIAL_BASE_PROMPT);
    expect(prompt).toContain('Focus: narrow till receipts');
    expect(prompt).toContain('GRAND TOTAL');
    expect(prompt).toContain('Document text:');
  });

  it('buildCloudExtractionPrompt includes arbitration conflict context', () => {
    const prompt = buildCloudExtractionPrompt({
      predictedType: 'invoice',
      conflicts: {
        totalAmount: { rulesValue: 100, localModelValue: 99 },
        currency: { rulesValue: 'USD', localModelValue: null },
      },
    });
    expect(prompt).toContain('Arbitration context');
    expect(prompt).toContain('totalAmount: rules=100 vs local_model=99');
    expect(prompt).toContain('currency: rules="USD" vs local_model=null');
  });

  it('buildCloudExtractionPrompt includes missing fields hint', () => {
    const prompt = buildCloudExtractionPrompt({
      predictedType: 'invoice',
      missingFields: ['invoiceNumber', 'totalAmount'],
    });
    expect(prompt).toContain('Priority missing fields to check: invoiceNumber, totalAmount.');
  });

  it('buildCloudExtractionPrompt does not add type note for unknown', () => {
    const prompt = buildCloudExtractionPrompt({ predictedType: 'unknown' });
    expect(prompt).not.toContain('System suggested');
    expect(prompt).toContain('Classification guide');
  });

  it('DOCUMENT_TYPE_FOCUS covers all DocumentType values', () => {
    const types: DocumentType[] = [
      'invoice',
      'receipt',
      'payment',
      'bill',
      'payslip',
      'settlement_slip',
      'other',
      'unknown',
    ];
    for (const t of types) {
      expect(DOCUMENT_TYPE_FOCUS[t]).toBeDefined();
      expect(DOCUMENT_TYPE_FOCUS[t]!.length).toBeGreaterThan(0);
    }
  });

  it('buildLocalModelPrompt is compact and includes example', () => {
    const prompt = buildLocalModelPrompt(
      'Acme Corp Invoice INV-123 Date 2024-02-01 Total $1300 USD',
      'Text: Acme Corp\nInvoice No: INV-123\nDate: 2024-02-01\nTotal: $1300 USD\nJSON: {"vendor":"Acme Corp","invoiceNumber":"INV-123","invoiceDate":"2024-02-01","totalAmount":1300,"currency":"USD"}'
    );
    expect(prompt).toContain('Extract vendor, invoiceNumber, invoiceDate');
    expect(prompt).toContain('JSON: {"vendor":"Acme Corp"');
    expect(prompt).toContain('Text: Acme Corp Invoice INV-123');
    expect(prompt).toContain('JSON:');
    // Under token budget for local model (1400 chars max)
    expect(prompt.length).toBeLessThan(2000);
  });

  it('buildLocalModelPrompt truncates long text', () => {
    const longText = 'x'.repeat(5000);
    const prompt = buildLocalModelPrompt(longText, 'Text: ex\nJSON: {}');
    const textParts = prompt.split('Text:');
    const snippet = textParts[textParts.length - 1]?.split('\nJSON:')[0]?.replace(/\n$/, '') ?? '';
    expect(snippet.length).toBeLessThan(2000);
    expect(snippet.length).toBeGreaterThan(1300);
  });
});
