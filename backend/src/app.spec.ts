import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';

describe('application security middleware', () => {
  it('does not grant CORS access to an unlisted origin', async () => {
    const response = await request(createApp())
      .get('/health')
      .set('Origin', 'https://unlisted.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires authentication on protected routes in test mode', async () => {
    const response = await request(createApp()).get('/api/documents');
    expect(response.status).toBe(401);
  });

  describe('CSRF origin guard', () => {
    it('allows a mutating cookie-authenticated request with a listed origin', async () => {
      const response = await request(createApp())
        .post('/api/auth/login')
        .set('Origin', 'http://localhost:5173')
        .send({ email: 'a@example.com', password: 'Password1!' });
      expect(response.status).not.toBe(403);
      expect((response.body as { code?: string }).code).not.toBe('CSRF_ORIGIN');
    });

    it('blocks a mutating cookie-authenticated request with a missing origin', async () => {
      const response = await request(createApp())
        .post('/api/auth/login')
        .send({ email: 'a@example.com', password: 'Password1!' });
      expect(response.status).toBe(403);
      expect((response.body as { code?: string }).code).toBe('CSRF_ORIGIN');
    });

    it('blocks a mutating cookie-authenticated request with a foreign origin', async () => {
      const response = await request(createApp())
        .post('/api/auth/login')
        .set('Origin', 'https://evil.example')
        .send({ email: 'a@example.com', password: 'Password1!' });
      expect(response.status).toBe(403);
      expect((response.body as { code?: string }).code).toBe('CSRF_ORIGIN');
    });

    it('does not block a bearer-token mutating request without an origin', async () => {
      const response = await request(createApp())
        .post('/api/auth/login')
        .set('Authorization', 'Bearer some-token')
        .send({ email: 'a@example.com', password: 'Password1!' });
      expect(response.status).not.toBe(403);
      expect((response.body as { code?: string }).code).not.toBe('CSRF_ORIGIN');
    });

    it('does not apply CSRF to GET requests', async () => {
      const response = await request(createApp())
        .get('/api/documents')
        .set('Origin', 'https://evil.example');
      expect(response.status).toBe(401);
      expect((response.body as { code?: string }).code).not.toBe('CSRF_ORIGIN');
    });
  });
});
