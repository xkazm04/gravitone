import { beforeAll, describe, expect, it, vi } from "vitest";
import { useCallback, useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FEATURES } from "@/lib/content";
import FeatureGrid from "./FeatureGrid";
import { FeatureSpotlight } from "./FeatureSpotlight";
import { PREVIEWS, PREVIEW_KEYS, VARIANTS, type PreviewKey } from "./previews";

/*
 * The grid and the spotlight are one mechanism split across two components and a
 * piece of page state, so they are tested together the way the page wires them.
 * `Harness` below is StudioDark's spotlight block, verbatim in shape — if the
 * page's copy of it drifts, these tests keep passing while the page breaks, so
 * the two must be read together.
 */
function Harness() {
  const [preview, setPreview] = useState<PreviewKey | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const openPreview = useCallback((key: PreviewKey) => setPreview(key), []);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, closePreview]);

  return (
    <>
      <FeatureGrid preview={preview} onOpen={openPreview} />
      <FeatureSpotlight preview={preview} onClose={closePreview} />
    </>
  );
}

function stubMedia(reduced: boolean) {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: reduced,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeAll(() => {
  // framer's whileInView needs an IntersectionObserver; jsdom has none. Firing
  // it immediately means the cards are in their settled state, which is what
  // every assertion below is about.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, isIntersecting: true } as IntersectionObserverEntry], this as never);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

describe("FeatureGrid", () => {
  it("renders one card per shipped feature, each with its copy", () => {
    stubMedia(false);
    render(<Harness />);
    const cards = screen.getAllByRole("button", { expanded: false });
    expect(cards).toHaveLength(8);
    expect(FEATURES).toHaveLength(8);
    for (const f of FEATURES) {
      expect(screen.getByText(f.title)).toBeTruthy();
      expect(screen.getByText(f.body)).toBeTruthy();
    }
  });

  it("keeps every card's copy and its diagram under the same key", () => {
    // A card whose key has no preview would open nothing; a preview with no card
    // would be unreachable. Both are silent failures, so they are typed AND
    // asserted.
    expect(FEATURES.map((f) => f.key).sort()).toEqual([...PREVIEW_KEYS].sort());
  });

  it("does NOT open on hover — click is the only open gesture", () => {
    stubMedia(false);
    render(<Harness />);
    const card = screen.getByText(FEATURES[0].title).closest("[role='button']")!;
    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.focus(card);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a modal on click", () => {
    stubMedia(false);
    render(<Harness />);
    fireEvent.click(screen.getByText(FEATURES[1].title).closest("[role='button']")!);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName(FEATURES[1].title);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("opens from the keyboard too — Enter is not a mouse", () => {
    stubMedia(false);
    render(<Harness />);
    const card = screen.getByText(FEATURES[2].title).closest("[role='button']")!;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("closes on Escape", async () => {
    stubMedia(false);
    render(<Harness />);
    fireEvent.click(screen.getByText(FEATURES[3].title).closest("[role='button']")!);
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the scrim is clicked", async () => {
    stubMedia(false);
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByText(FEATURES[5].title).closest("[role='button']")!);
    const scrim = container.querySelector("[aria-hidden].absolute.inset-0")!;
    fireEvent.click(scrim);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("marks each openable card with the expand affordance glyph", () => {
    stubMedia(false);
    const { container } = render(<Harness />);
    // One quiet symbol per card, no "click here" caption anywhere.
    expect(container.querySelectorAll("[role='button'] svg.lucide-maximize-2, [role='button'] svg.lucide-maximize2").length + container.querySelectorAll("[role='button'] span[aria-hidden] svg").length).toBeGreaterThanOrEqual(8);
    expect(screen.queryByText(/click here/i)).toBeNull();
    expect(screen.queryByText(/hover any card/i)).toBeNull();
  });

  it("renders every diagram whole under reduced motion — stopped, not missing", async () => {
    stubMedia(true);
    render(<Harness />);
    for (const f of FEATURES) {
      fireEvent.click(screen.getByText(f.title).closest("[role='button']")!);
      const dialog = screen.getByRole("dialog");
      // Every preview ends on a closing note. If reduced motion had DROPPED
      // elements rather than stopping their animation — the mistake that takes
      // hydration down with it — this is what would be missing.
      expect(dialog.textContent?.length ?? 0).toBeGreaterThan(200);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });

  // PROTOTYPING SCAFFOLD — retire with the `bodies` map. The test above only
  // ever opens the DEFAULT lens, so without this the signal/stage variants
  // would carry no reduced-motion guard at all — and the illustration
  // vocabulary is exactly where "gate the animation, keep the element" is easy
  // to get wrong, because a stilled path that renders nothing still renders an
  // <svg>.
  it("renders every registered variant whole under reduced motion", () => {
    stubMedia(true);
    const thin: string[] = [];
    for (const key of PREVIEW_KEYS) {
      for (const variant of VARIANTS) {
        const Body = PREVIEWS[key].bodies[variant];
        if (!Body) continue;
        const { container, unmount } = render(<Body still />);
        const text = container.textContent?.length ?? 0;
        // A drawn variant with no geometry is the failure this catches: an
        // <svg> whose children were dropped under `still` still renders an
        // <svg>, so the element count is what proves the picture survived.
        const marks = container.querySelectorAll("*").length;
        if (text < 40 || marks < 10) thin.push(`${key}/${variant} (${text} chars, ${marks} marks)`);
        unmount();
      }
    }
    expect(thin).toEqual([]);
  });
});
