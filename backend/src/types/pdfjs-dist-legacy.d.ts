declare module 'pdfjs-dist/legacy/build/pdf.js' {
  import * as pdfjsLib from 'pdfjs-dist';

  export { pdfjsLib };
  export default pdfjsLib;

  export function getDocument(params: pdfjsLib.DocumentParameters): pdfjsLib.PDFDocumentLoadingTask;
  export const version: string;
}
