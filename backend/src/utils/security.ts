/**
 * security.ts — Input validation helpers.
 *
 * (Previously held isSuspicious(), a regex-based input filter. Removed:
 * every SQL query uses parameterized placeholders, and input validation is
 * handled by zod schemas instead of regex denylists.)
 */
