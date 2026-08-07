import { beforeAll, describe, expect, it, vi } from "vitest";
import { useCallback, useEffect, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FEATURES } from "@/lib/content";
import FeatureGrid from "./FeatureGrid";
import { FeatureSpotlight } from "./FeatureSpotlight";
import { PREVIEW_KEYS, type PreviewKey } from "./previews";

/*
 * The grid and the spotlight are one mechanism split across two components and a
 * piece of page state, so they are tested together the way the page wires them.
 * `Harness` below is StudioDark's spotlight block, verbatim in shape — if the
 * page's copy of it drifts, these tests keep passing while the page breaks, so
 * the two must be read together.
 */
function Harness() {
  const [preview, setPreview] = useState<PreviewKey | null>(null);
  const [pinned, setPinned] = useState(false);
  const suppressHoverUntil = useRef(0);

  const closePreview = useCallback(() => {
    setPreview(null);
    setPinned(false);
    suppressHoverUntil.current = Date.now() + 350;
  }, []);
  const hoverOpen = useCallback(
    (key: PreviewKey) => {
      if (pinned || Date.now() < suppressHoverUntil.current) return;
      setPreview(key);
    },
    [pinned],
  );
  const pinOpen = useCallback((key: PreviewKey) => {
    setPreview(key);
    setPinned(true);
  }, []);

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
      <FeatureGrid
        preview={preview}
        pinned={pinned}
        onHoverOpen={hoverOpen}
        onPin={pinOpen}
        onLeave={() => setPreview(null)}
      />
      <FeatureSpotlight preview={preview} pinned={pinned} onClose={closePreview} />
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

  it("opens a peek on hover that the cursor can simply walk away from", async () => {
    stubMedia(false);
    render(<Harness />);
    const card = screen.getByText(FEATURES[0].title).closest("[role='button']")!;

    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName(FEATURES[0].title);
    // A peek is inert: no aria-modal, and the overlay does not take the pointer.
    expect(dialog).not.toHaveAttribute("aria-modal", "true");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    fireEvent.pointerLeave(card, { pointerType: "mouse" });
    // AnimatePresence holds the node through its exit, so removal is awaited
    // rather than asserted on the next tick.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("pins on click, and pinning is what makes it a modal", () => {
    stubMedia(false);
    render(<Harness />);
    fireEvent.click(screen.getByText(FEATURES[1].title).closest("[role='button']")!);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    // Pinned, hovering another card must not steal the modal out from under a
    // reader who deliberately opened this one.
    fireEvent.pointerEnter(screen.getByText(FEATURES[4].title).closest("[role='button']")!, {
      pointerType: "mouse",
    });
    expect(screen.getByRole("dialog")).toHaveAccessibleName(FEATURES[1].title);
  });

  it("pins from the keyboard too — Enter is not a mouse", () => {
    stubMedia(false);
    render(<Harness />);
    const card = screen.getByText(FEATURES[2].title).closest("[role='button']")!;
    fireEvent.focus(card);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("closes on Escape, and does not spring straight back open under the cursor", async () => {
    stubMedia(false);
    render(<Harness />);
    const card = screen.getByText(FEATURES[3].title).closest("[role='button']")!;
    fireEvent.click(card);
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The browser re-fires hover on the card the overlay just stopped covering.
    // Without the suppression window that would reopen what was just dismissed.
    fireEvent.pointerEnter(card, { pointerType: "mouse" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores hover from a finger — a tap must not peek and pin at once", () => {
    stubMedia(false);
    render(<Harness />);
    const card = screen.getByText(FEATURES[6].title).closest("[role='button']")!;
    // On a touchscreen `pointerenter` fires immediately before the click.
    fireEvent.pointerEnter(card, { pointerType: "touch" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(card);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("closes when the scrim is clicked", async () => {
    stubMedia(false);
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByText(FEATURES[5].title).closest("[role='button']")!);
    const scrim = container.querySelector("[aria-hidden].absolute.inset-0")!;
    fireEvent.click(scrim);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders every diagram whole under reduced motion — stopped, not missing", async () => {
    stubMedia(true);
    render(<Harness />);
    for (const f of FEATURES) {
      // Pinning ignores the hover-suppression window, so each card can be opened
      // straight after the previous one closed.
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
});
