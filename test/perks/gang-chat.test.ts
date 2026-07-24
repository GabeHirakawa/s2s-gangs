import { describe, it, expect } from "vitest";
import { parseGangChat } from "../../src/perks/gang-chat-parse";

describe("parseGangChat", () => {
  it("strips a leading dot and trims", () => {
    expect(parseGangChat(".hello team")).toBe("hello team");
    expect(parseGangChat(".  spaced ")).toBe("spaced");
  });
  it("returns null for non-gang-chat or empty", () => {
    expect(parseGangChat("hello")).toBeNull();
    expect(parseGangChat(".")).toBeNull();
    expect(parseGangChat("")).toBeNull();
  });
});
