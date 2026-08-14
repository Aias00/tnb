import { describe, expect, test } from "bun:test";
import {
  createViewportState,
  resizeViewport,
  scrollBy,
  scrollHalfPage,
  scrollPage,
  scrollToBottom,
  scrollToTop,
  updateContentHeight,
} from "../../src/ui/transcript/viewport-state";

describe("transcript viewport state", () => {
  test("starts pinned to the bottom and clamps line scrolling", () => {
    const initial = createViewportState(10, 30);
    expect(initial).toMatchObject({ scrollTop: 20, followBottom: true });
    const detached = scrollBy(initial, -3);
    expect(detached).toMatchObject({ scrollTop: 17, followBottom: false });
    expect(scrollBy(detached, 99)).toMatchObject({ scrollTop: 20, followBottom: true });
    expect(scrollBy(detached, -99).scrollTop).toBe(0);
  });

  test("moves by page and half page", () => {
    const bottom = createViewportState(9, 40);
    expect(scrollPage(bottom, "up").scrollTop).toBe(22);
    expect(scrollHalfPage(bottom, "up").scrollTop).toBe(27);
    expect(scrollHalfPage(createViewportState(0, 4), "up").scrollTop).toBe(3);
  });

  test("supports top and bottom commands", () => {
    const initial = createViewportState(5, 20);
    expect(scrollToTop(initial)).toMatchObject({ scrollTop: 0, followBottom: false });
    expect(scrollToBottom(scrollToTop(initial))).toMatchObject({ scrollTop: 15, followBottom: true });
  });

  test("follows content growth only while pinned", () => {
    const pinned = createViewportState(10, 20);
    expect(updateContentHeight(pinned, 25).scrollTop).toBe(15);
    const detached = scrollBy(pinned, -4);
    expect(updateContentHeight(detached, 25)).toMatchObject({ scrollTop: 6, followBottom: false });
  });

  test("resizes top, middle, and bottom positions", () => {
    const bottom = createViewportState(10, 30);
    expect(resizeViewport(bottom, 5)).toMatchObject({ scrollTop: 25, followBottom: true });
    const middle = scrollBy(bottom, -5);
    expect(resizeViewport(middle, 20)).toMatchObject({ scrollTop: 10, followBottom: false });
    expect(resizeViewport(scrollToTop(bottom), 40)).toMatchObject({ scrollTop: 0, followBottom: false });
  });

  test("normalizes zero and invalid dimensions", () => {
    expect(createViewportState(-1, Number.NaN)).toEqual({ viewportHeight: 0, contentHeight: 0, scrollTop: 0, followBottom: true });
    expect(updateContentHeight(createViewportState(0, 0), 3)).toMatchObject({ scrollTop: 3, followBottom: true });
  });
});
