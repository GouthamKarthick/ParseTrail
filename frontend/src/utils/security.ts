// Shared upload limits — used by Upload client-side validation and must match
// backend middleware/upload.ts limits.
export const UPLOAD_LIMITS = {
  maxFileSize: 10 * 1024 * 1024, // 10 MB
  allowedMimes: new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']),
  allowedExtensions: ['.pdf', '.png', '.jpg', '.jpeg'],
} as const;

/**
 * Validates a file against client-side upload limits.
 * @param file - File to validate
 * @returns Error message or null if valid
 */
export function validateUploadFile(file: File): string | null {
  if (!UPLOAD_LIMITS.allowedMimes.has(file.type)) {
    return 'Invalid file type. Only PDF, PNG, and JPG are allowed.';
  }
  if (file.size > UPLOAD_LIMITS.maxFileSize) {
    return 'File too large. Maximum size is 10 MB.';
  }
  const ext = file.name.toLowerCase().slice(-4) as '.pdf' | '.png' | '.jpg' | '.jpeg';
  if (!UPLOAD_LIMITS.allowedExtensions.includes(ext)) {
    return 'Invalid file extension. Only .pdf, .png, .jpg, .jpeg are allowed.';
  }
  return null;
}

/**
 * Validate password against strength policy.
 * @param pwd - Candidate password
 * @returns Error message or null if valid
 * @example getPasswordError("weak")
 */
export function getPasswordError(pwd: string): string | null {
  if (pwd.length < 8) return 'Password must be at least 8 characters';
  if (new TextEncoder().encode(pwd).length > 72)
    return 'Password must be at most 72 bytes (bcrypt limit)';
  if (!/[A-Z]/.test(pwd)) return 'Password must contain 1 uppercase letter';
  if (!/\d/.test(pwd)) return 'Password must contain 1 number';
  if (!/[^A-Za-z0-9]/.test(pwd)) return 'Password must contain 1 special character';
  return null;
}
