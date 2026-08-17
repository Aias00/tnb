import { beforeEach, describe, expect, test } from "bun:test";

import {
  Cursor,
  clearKillRing,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  yankPop,
} from "../../src/ui/input/cursor";

describe("Cursor input engine", () => {
  beforeEach(() => clearKillRing());

  test("moves over emoji and combining sequences as complete graphemes", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `A${family}e\u0301B`;
    const afterA = Cursor.fromText(text, 40, 1).right();
    expect(afterA.offset).toBe(1 + family.length);
    expect(afterA.right().offset).toBe(1 + family.length + 1);
    expect(afterA.left().offset).toBe(1);
  });

  test("moves vertically by wrapped terminal rows", () => {
    const cursor = Cursor.fromText("abcdefghij", 6, 7);
    expect(cursor.getPosition()).toEqual({ line: 1, column: 2 });
    expect(cursor.up().offset).toBe(2);
    expect(cursor.up().down().offset).toBe(7);
  });

  test("counts CJK as two terminal cells", () => {
    const cursor = Cursor.fromText("ab界cd", 8, 3);
    expect(cursor.getPosition()).toEqual({ line: 0, column: 4 });
    expect(cursor.right().offset).toBe(4);
  });

  test("never wraps inside a multi-code-point grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    const lines = Cursor.fromText(`ab界cd${family}efghij`, 12, 5).measuredText.getWrappedText();
    expect(lines.some((line) => line.includes(family))).toBe(true);
    expect(lines.join("")).toBe(`ab界cd${family}efghij`);
  });

  test("accumulates consecutive kills and rotates prior kills", () => {
    pushToKillRing("world", "append");
    pushToKillRing("hello ", "prepend");
    expect(getLastKill()).toBe("hello world");
    resetKillAccumulation();
    pushToKillRing("replacement");
    recordYank(0, "replacement".length);
    expect(yankPop()?.text).toBe("hello world");
  });
});
