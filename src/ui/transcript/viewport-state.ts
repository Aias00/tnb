export type ViewportState = {
  viewportHeight: number;
  contentHeight: number;
  scrollTop: number;
  followBottom: boolean;
};

type Direction = "up" | "down";

const size = (value: number) => Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
export const maxScrollTop = (state: Pick<ViewportState, "contentHeight" | "viewportHeight">) =>
  Math.max(0, state.contentHeight - state.viewportHeight);

export function createViewportState(viewportHeight: number, contentHeight: number): ViewportState {
  const state = { viewportHeight: size(viewportHeight), contentHeight: size(contentHeight), scrollTop: 0, followBottom: true };
  return { ...state, scrollTop: maxScrollTop(state) };
}

export function scrollBy(state: ViewportState, rows: number): ViewportState {
  const maximum = maxScrollTop(state);
  const scrollTop = Math.max(0, Math.min(maximum, state.scrollTop + Math.trunc(rows)));
  return { ...state, scrollTop, followBottom: scrollTop === maximum };
}

export function scrollPage(state: ViewportState, direction: Direction): ViewportState {
  return scrollBy(state, (direction === "up" ? -1 : 1) * Math.max(1, state.viewportHeight));
}

export function scrollHalfPage(state: ViewportState, direction: Direction): ViewportState {
  return scrollBy(state, (direction === "up" ? -1 : 1) * Math.max(1, Math.floor(state.viewportHeight / 2)));
}

export function scrollToTop(state: ViewportState): ViewportState {
  return { ...state, scrollTop: 0, followBottom: maxScrollTop(state) === 0 };
}

export function scrollToBottom(state: ViewportState): ViewportState {
  return { ...state, scrollTop: maxScrollTop(state), followBottom: true };
}

export function resizeViewport(state: ViewportState, viewportHeight: number): ViewportState {
  const next = { ...state, viewportHeight: size(viewportHeight) };
  const maximum = maxScrollTop(next);
  return { ...next, scrollTop: state.followBottom ? maximum : Math.min(state.scrollTop, maximum) };
}

export function updateContentHeight(state: ViewportState, contentHeight: number): ViewportState {
  const next = { ...state, contentHeight: size(contentHeight) };
  const maximum = maxScrollTop(next);
  return { ...next, scrollTop: state.followBottom ? maximum : Math.min(state.scrollTop, maximum) };
}
