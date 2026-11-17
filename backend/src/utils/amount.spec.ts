import { describe, it, expect } from 'vitest';
import { parseAmount } from './amount.js';

describe('parseAmount — European number formats', () => {
  const cases: Array<[unknown, number | null]> = [
    // numbers pass through unchanged when finite
    [1234.56, 1234.56],
    // dot-decimal with thousands comma (US/UK)
    ['1,234.56', 1234.56],
    // dot-thousands + comma-decimal (German/EU)
    ['1.234,56', 1234.56],
    ['1.234,56 €', 1234.56],
    // comma-decimal with spaces and currency symbol
    ['€ 1 234,56', 1234.56],
    ['€ 1\u00A0234,56', 1234.56],
    // Swiss apostrophe thousands + dot decimal
    ["CHF 1'234.50", 1234.5],
    // comma-decimal (1 or 2 digits)
    ['12,50', 12.5],
    ['12,5', 12.5],
    // Indian grouping with dot decimal
    ['1,23,456.78', 123456.78],
    ['Rs. 5380.8', 5380.8],
    // leading minus
    ['-12,50', -12.5],
    // unparseable / empty
    ['abc', null],
    ['', null],
    ['   ', null],
    // non-finite numbers
    [NaN, null],
    [Infinity, null],
    [-Infinity, null],
  ];

  it.each(cases)('parseAmount(%s) -> %s', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });
});
