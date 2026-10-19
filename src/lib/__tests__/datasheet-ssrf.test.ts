import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "@/lib/datasheet";

describe("isPrivateAddress", () => {
  it("blocks the metadata service and private IPv4 ranges", () => {
    for (const h of ["169.254.169.254", "10.1.2.3", "172.20.0.1", "192.168.1.1", "127.0.0.1", "0.0.0.0", "100.64.0.1", "198.18.0.1", "224.0.0.1"]) {
      expect(isPrivateAddress(h), h).toBe(true);
    }
  });

  it("unwraps IPv4-mapped IPv6 in both notations", () => {
    expect(isPrivateAddress("[::ffff:169.254.169.254]")).toBe(true);
    expect(isPrivateAddress("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks reserved IPv6 ranges", () => {
    for (const h of ["::", "::1", "fd00::1", "fe80::1", "fec0::1", "ff02::1", "64:ff9b::a9fe:a9fe"]) {
      expect(isPrivateAddress(h), h).toBe(true);
    }
  });

  it("lets public addresses and names through (names are checked at connect time)", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2a00:1450:4001:80b::200e")).toBe(false);
    expect(isPrivateAddress("www.ti.com")).toBe(false);
    expect(isPrivateAddress("localhost")).toBe(true);
    expect(isPrivateAddress("printer.local")).toBe(true);
  });
});
