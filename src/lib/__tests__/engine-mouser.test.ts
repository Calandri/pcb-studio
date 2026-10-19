import { describe, expect, it } from "vitest";
import { mouserCurrency, parseMouserPrice } from "@/lib/mouser";

describe("Mouser prices, whatever the locale of the key", () => {
  it("reads the decimal comma", () => {
    expect(parseMouserPrice("0,123 €")).toBe(0.123);
    expect(parseMouserPrice("1.234,56 €")).toBe(1234.56);
  });

  it("reads the decimal dot", () => {
    expect(parseMouserPrice("$0.123")).toBe(0.123);
    expect(parseMouserPrice("$1,234.56")).toBe(1234.56);
    expect(parseMouserPrice("1.234.567")).toBe(1234567);
  });

  it("says nothing when there is no price", () => {
    expect(parseMouserPrice("")).toBeNull();
    expect(parseMouserPrice(undefined)).toBeNull();
    expect(parseMouserPrice("N/A")).toBeNull();
  });

  it("knows the currency", () => {
    expect(mouserCurrency("EUR", "0,1 €")).toBe("EUR");
    expect(mouserCurrency(undefined, "$1.00")).toBe("USD");
    expect(mouserCurrency(undefined, "0,10 €")).toBe("EUR");
    expect(mouserCurrency(undefined, "1.00")).toBeNull();
  });
});
