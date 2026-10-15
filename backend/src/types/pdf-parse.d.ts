/**
 * types/pdf-parse.d.ts — Type declarations for pdf-parse.
 */

declare module "pdf-parse" {
  function pdfParse(
    data: Buffer,
    options?: unknown,
  ): Promise<{ text: string; numpages: number; info: unknown }>;
  export default pdfParse;
}

declare module "pdf-parse/lib/pdf-parse.js" {
  function pdfParse(
    data: Buffer,
    options?: unknown,
  ): Promise<{ text: string; numpages: number; info: unknown }>;
  export default pdfParse;
}
