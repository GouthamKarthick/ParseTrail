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
});
