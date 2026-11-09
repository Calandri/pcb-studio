import { describe, expect, it } from "vitest";

describe("i cinque progetti importati specchiati lo dicono", () => {
  it("avviso per quei cinque, niente per gli altri", async () => {
    const { avvisoDelProgetto } = await import("@/lib/progetti-con-difetti");
    for (const p of ["bat-bs", "birdy-bs", "altium-ht-tm-4g-hqt3x", "altium-queen-ht-jtkr5"]) {
      expect(avvisoDelProgetto(p)).toMatch(/specchiatura in y del 09\/11: non usare per produzione, reimportare/);
    }
    // the straightened ones and everything else: no warning
    // tm-4l-r3 re-imported with the fix: no longer mirrored
    for (const p of ["tm-4l-r3", "birdy-bat", "birdy-bat-v1-2", "sbb-dl-retro", "prova-salvataggio-retro"]) expect(avvisoDelProgetto(p)).toBeNull();
  });
});
