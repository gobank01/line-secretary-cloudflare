import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("identifies the Cloudflare service", async () => {
    const response = await exports.default.fetch("http://example.com/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "line-secretary-cloudflare",
      environment: "local",
    });
  });
});
