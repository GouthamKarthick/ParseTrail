import { describe, it, expect } from 'vitest';
import { upload } from './upload.js';

describe('middleware/upload — multer config', () => {
  it('exists and has single file handler', () => {
    expect(upload).toBeDefined();
    expect(typeof upload.single).toBe('function');
  });
});
