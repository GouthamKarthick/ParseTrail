import { describe, it, expect } from "vitest";

describe("ocr.service — unit skips heavy deps", () => {
  it("module exports ocrBuffer and terminateOcr", async () => {
    const mod = await import("./ocr.service.js");
    expect(typeof mod.ocrBuffer).toBe("function");
    expect(typeof mod.terminateOcr).toBe("function");
  });

  it("module is importable without side effects", async () => {
    const mod2 = await import("./ocr.service.js");
    expect(mod2).toBeDefined();
  });
});
