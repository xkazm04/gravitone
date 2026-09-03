import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import SectionRail from "./SectionRail";

// The rail is three browser APIs in a trenchcoat — scroll position, an
// IntersectionObserver and scrollIntoView — none of which jsdom provides
// usefully. Each is stubbed so the component's own logic (reveal threshold,
// first-in-order active tiebreak, hash write) is what is under test.

type IoCallback = (entries: { target: { id: string }; isIntersecting: boolean }[]) => void;

let observerCallback: IoCallback | null = null;
const observed: string[] = [];
const disconnect = vi.fn();

function setScrollY(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, writable: true, configurable: true });
}

/** Feed the observer the way the browser would, inside act(). */
function observe(entries: { id: string; isIntersecting: boolean }[]) {
  act(() => {
    observerCallback?.(entries.map((e) => ({ target: { id: e.id }, isIntersecting: e.isIntersecting })));
  });
}

/** Mount the five sections the rail navigates, so getElementById finds them. */
function mountSections() {
  for (const id of ["why", "voices", "api", "switch", "playground"]) {
    const el = document.createElement("section");
    el.id = id;
    // jsdom has no layout, so it has no scrollIntoView either.
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
  }
}

beforeEach(() => {
  observerCallback = null;
  observed.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IoCallback) {
        observerCallback = cb;
      }
      observe(el: Element) {
        observed.push(el.id);
      }
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn();
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  setScrollY(1200); // past the hero — the rail is showing
  mountSections();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("SectionRail", () => {
  it("stays out of the way until the visitor has scrolled past the hero", () => {
    setScrollY(0);
    render(<SectionRail />);
    expect(screen.queryByRole("navigation", { name: "Page sections" })).toBeNull();
  });

  it("navigates the five marketing sections, plus back-to-top", () => {
    render(<SectionRail />);
    const nav = screen.getByRole("navigation", { name: "Page sections" });
    expect(nav).toBeTruthy();
    // Labels are what the visitor reads; hrefs are the ids already in the page.
    for (const [label, id] of [
      ["why", "why"],
      ["voices", "voices"],
      ["features", "api"],
      ["pricing", "switch"],
      ["playground", "playground"],
    ]) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", `#${id}`);
    }
    expect(screen.getByRole("button", { name: "top" })).toBeTruthy();
    // Every section it lists, it observes — an entry it cannot track would be a
    // dead label that never lights up.
    expect(observed).toEqual(["why", "voices", "api", "switch", "playground"]);
  });

  it("shows the same five entries whether or not anyone is signed in", () => {
    // There is no auth prop and no MODULES import by design: the rail is
    // marketing navigation, so a signed-out visitor gets the whole page.
    render(<SectionRail />);
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("scrolls to the section and rewrites the hash without stacking history", () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    render(<SectionRail />);

    act(() => {
      screen.getByRole("link", { name: "pricing" }).click();
    });

    const target = document.getElementById("switch")!;
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "#switch");
    // A scrubber, not a trail of destinations.
    expect(pushState).not.toHaveBeenCalled();
  });

  it("marks the section crossing the viewport's middle band as current", () => {
    render(<SectionRail />);
    expect(screen.queryByRole("link", { current: true })).toBeNull();

    observe([{ id: "voices", isIntersecting: true }]);
    expect(screen.getByRole("link", { current: true })).toHaveTextContent("voices");

    // Two sections straddling the band at once: the earlier one down the page
    // wins, so a short section handing off to a tall one cannot flicker.
    observe([{ id: "api", isIntersecting: true }]);
    expect(screen.getByRole("link", { current: true })).toHaveTextContent("voices");

    observe([{ id: "voices", isIntersecting: false }]);
    expect(screen.getByRole("link", { current: true })).toHaveTextContent("features");

    observe([{ id: "api", isIntersecting: false }]);
    expect(screen.queryByRole("link", { current: true })).toBeNull();
  });

  it("jumps instantly when the visitor asked for reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<SectionRail />);

    // Every entry is still present — reduced motion stops the animation, it
    // does not drop elements (that is what breaks hydration).
    expect(screen.getAllByRole("link")).toHaveLength(5);

    act(() => {
      screen.getByRole("link", { name: "why" }).click();
    });
    expect(document.getElementById("why")!.scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });
});
