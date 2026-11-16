import { describe, it, expect } from 'vitest';
import { normalizeDateISO } from './date.js';
import { standardizeCurrency, findCurrencyInText } from './currency.js';
import { parseAmount } from './amount.js';
import { stripJsonFence, parseJsonColumn } from './json.js';

describe('utils — shared extractors', () => {
  it('normalizeDateISO handles all known shapes', () => {
    expect(normalizeDateISO('2026-09-03')).toBe('2026-09-03');
    expect(normalizeDateISO('03/09/2026')).toBe('2026-09-03');
    expect(normalizeDateISO('03-09-2026')).toBe('2026-09-03');
    expect(normalizeDateISO('07.01.2021')).toBe('2021-01-07');
    expect(normalizeDateISO('  2026-09-03  ')).toBe('2026-09-03');
    expect(normalizeDateISO('garbage')).toBe('garbage');
  });
  it('standardizeCurrency maps codes and symbols', () => {
    expect(standardizeCurrency('inr')).toBe('INR');
    expect(standardizeCurrency('GBP')).toBe('GBP');
    expect(standardizeCurrency('₹1')).toBe('INR');
    expect(standardizeCurrency('Rs.')).toBe('INR');
    expect(standardizeCurrency('$')).toBe('USD');
    expect(standardizeCurrency('€')).toBe('EUR');
    expect(standardizeCurrency('£')).toBe('GBP');
    expect(standardizeCurrency('JPY')).toBeNull();
    expect(standardizeCurrency('')).toBeNull();
    expect(standardizeCurrency(42)).toBeNull();
  });
  it('findCurrencyInText scans symbols', () => {
    expect(findCurrencyInText('Total ₹500')).toBe('INR');
    expect(findCurrencyInText('Total Rs 500')).toBe('INR');
    expect(findCurrencyInText('Total $500')).toBe('USD');
    expect(findCurrencyInText('Total €500')).toBe('EUR');
    expect(findCurrencyInText('Total £500')).toBe('GBP');
    expect(findCurrencyInText('Total 500')).toBeNull();
    expect(findCurrencyInText('Annual AUDIT report 100')).toBeNull();
    expect(findCurrencyInText('CADENCE services total 50')).toBeNull();
    expect(findCurrencyInText('Total A$ 100')).toBe('AUD');
    expect(findCurrencyInText('Total 100 AUD')).toBe('AUD');
    expect(findCurrencyInText('Total S$100')).toBe('SGD');
    expect(findCurrencyInText('Total 100 CAD')).toBe('CAD');
    expect(findCurrencyInText('Total $100')).toBe('USD');
  });
  it('parseAmount scrubs locale noise', () => {
    expect(parseAmount('Rs. 1,200.00')).toBe(1200);
    expect(parseAmount('£1,342.74')).toBe(1342.74);
    expect(parseAmount('€ 99')).toBe(99);
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(Infinity)).toBeNull();
  });
  it('stripJsonFence removes fences', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
  it('parseJsonColumn tolerates objects and garbage', () => {
    expect(parseJsonColumn('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJsonColumn({ a: 1 }, {})).toEqual({ a: 1 });
    expect(parseJsonColumn('nope', { d: 1 })).toEqual({ d: 1 });
    expect(parseJsonColumn(null, { d: 1 })).toEqual({ d: 1 });
  });
});
