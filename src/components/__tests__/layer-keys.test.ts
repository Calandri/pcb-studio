import { describe, expect, it } from "vitest";
import { layerForKey } from "../board/render";

/* 1, 2, 3, 4 = uno strato in ordine di stackup; 0 = tutti; oltre il numero di strati niente (2026-11-09) */
describe("tasti degli strati", () => {
  it("scheda a 4 strati", () => {
    expect(["1", "2", "3", "4"].map((k) => layerForKey(k, 4))).toEqual(["top", "inner1", "inner2", "bottom"]);
    expect(layerForKey("5", 4)).toBeNull();
    expect(layerForKey("0", 4)).toBe("all");
  });
  it("scheda a 2 strati: 2 e' Bottom, 3 non fa niente", () => {
    expect(layerForKey("2", 2)).toBe("bottom");
    expect(layerForKey("3", 2)).toBeNull();
  });
  it("gli altri tasti non sono strati", () => {
    expect(layerForKey("r", 4)).toBeNull();
    expect(layerForKey("10", 4)).toBeNull();
  });
});
