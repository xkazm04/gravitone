// DOM matchers (toBeEmptyDOMElement, toHaveTextContent, …) for every test file.
import "@testing-library/jest-dom/vitest";

/*
 * `window.matchMedia`, which jsdom does not implement at all.
 *
 * `lib/useStillMotion` reads it on every render, and the Signal design language
 * (web/DESIGN.md) requires every drawn surface to be still-aware — so ANY test
 * that renders a tree containing an illustration crashes on a missing global
 * that has nothing to do with what it is asserting. The default is the same
 * answer the server gives ("motion is fine"), so it changes no existing
 * behaviour; a test that cares about the reduced-motion branch still stubs it
 * for itself with `vi.stubGlobal`.
 */
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
