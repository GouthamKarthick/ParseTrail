import type { AuthUser } from '../middleware/auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      cookies?: Record<string, string>;
      _pagination?: {
        limit: number;
        offset: number;
        q?: string;
        document_type?: string[];
        document_category?: string;
      };
      parsedId?: string;
    }
  }
}
