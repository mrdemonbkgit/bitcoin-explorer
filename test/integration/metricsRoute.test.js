import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/server.js';

describe('metrics route', () => {
  it('returns 404 when metrics are disabled', async () => {
    const app = createApp();
    const response = await request(app).get('/metrics');

    expect(response.status).toBe(404);
    expect(response.text).toContain('Metrics disabled');
  });
});
