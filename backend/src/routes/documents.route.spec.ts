import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

describe("routes — documents", () => {
  it("GET /health → 200 ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /api/documents validates pagination (400 on bad limit)", async () => {
    const app = createApp();
    const res = await request(app).get("/api/documents?limit=9999");
    expect(res.status).toBe(400);
  });

  it("POST /api/documents/upload 400 when no file", async () => {
    const app = createApp();
    const res = await request(app).post("/api/documents/upload");
    expect(res.status).toBe(400);
  });

  it("GET /api/documents/:id 400 invalid uuid", async () => {
    const app = createApp();
    const res = await request(app).get("/api/documents/bad-id");
    expect(res.status).toBe(400);
  });

  it("POST /api/documents/:id/refinement/retry 400 invalid uuid", async () => {
    const app = createApp();
    const res = await request(app).post(
      "/api/documents/bad-id/refinement/retry",
    );
    expect(res.status).toBe(400);
  });
});
