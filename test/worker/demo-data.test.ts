import { describe, expect, it } from "vitest";
import { buildDemoDataset, renderDemoSeedSql } from "../../scripts/demo-data";

describe("demo dataset", () => {
  it("builds the same 100 categorized groups for the same seed", () => {
    const first = buildDemoDataset(100, 20_260_823);
    const second = buildDemoDataset(100, 20_260_823);

    expect(first).toEqual(second);
    expect(first.groups).toHaveLength(100);
    expect(new Set(first.groups.map((group) => group.sourceId)).size).toBe(100);
    expect(new Set(first.groups.map((group) => group.categorySlug))).toEqual(
      new Set(["customer", "team", "order", "partner", "project", "other"]),
    );
    expect(first.reports).toHaveLength(100);
  });

  it("renders a demo-only reseed without explicit transactions", () => {
    const sql = renderDemoSeedSql(buildDemoDataset(3, 20_260_823));

    expect(sql).toContain("DELETE FROM groups WHERE data_mode = 'demo'");
    expect(sql.match(/INSERT INTO groups/g)).toHaveLength(3);
    expect(sql).not.toContain("DELETE FROM groups WHERE data_mode = 'real'");
    // Remote D1 rejects explicit BEGIN/COMMIT — the file must stay transaction-free.
    expect(sql).not.toMatch(/BEGIN TRANSACTION|COMMIT;/);
  });
});
