import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import EmotionIcon from "./EmotionIcon";
import { EMOTION_ICONS, EMOTION_IDS, emotionIcon } from "@/lib/emotions";

// The icon exists because the generated sigils were unreadable at badge scale:
// abstract art, filled with the RAW emotion hue, on a near-black panel. So the
// two things asserted here are the two things that failed — a real icon per
// emotion, and a foreground light enough to be seen.

/** The rendered `<svg>` for one emotion. */
const svg = (emotion: string) =>
  render(<EmotionIcon emotion={emotion} />).container.querySelector(`[data-emotion-icon="${emotion}"]`) as SVGSVGElement;

/** jsdom serialises every colour to `rgb()`/`rgba()`, so contrast is measured
 *  from the channels rather than asserted on the authored notation. */
function channels(color: string): [number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
  if (!m) throw new Error(`not an rgb colour: ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG relative luminance. */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The app's darkest panel — what an emotion icon is actually drawn on. */
const PANEL = "rgb(11, 14, 21)";

function contrast(color: string): number {
  const a = luminance(color);
  const b = luminance(PANEL);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("EmotionIcon — readable at the size it is actually used", () => {
  it("gives every base emotion its own icon from the shared table", () => {
    for (const id of EMOTION_IDS) expect(EMOTION_ICONS[id]).toBeTypeOf("object");
    // Distinct components — a table that mapped three emotions to one shape
    // would be no more identifying than the sigils it replaced.
    const shapes = new Set(EMOTION_IDS.map((id) => emotionIcon(id)));
    expect(shapes.size).toBe(EMOTION_IDS.length);
  });

  it("gives a CUSTOM emotion a stable icon rather than nothing", () => {
    expect(emotionIcon("battle_cry")).toBeTypeOf("object");
    expect(emotionIcon("battle_cry")).toBe(emotionIcon("battle_cry"));
  });

  it("draws every emotion at a foreground luminance, not the raw span tint", () => {
    // The span highlights paint `hsl(h 82% 55%)` — fine as a wash behind words,
    // and the thing that made these marks unreadable as a stroke. Non-text
    // graphics need 3:1 (WCAG 1.4.11); the lifted hue clears 7:1 on every one.
    for (const id of EMOTION_IDS) {
      expect(contrast(svg(id).style.color), id).toBeGreaterThanOrEqual(7);
    }
    // The raw hue is what the lift is measured against — assert it would have
    // failed, so this test cannot pass by accident if the lift is removed.
    // = hsl(225 82% 55%), the tint Sad's words are washed with.
    expect(contrast("rgb(46, 93, 234)")).toBeLessThan(4.5);
  });

  it("never renders below the 16px floor by default", () => {
    const el = svg("calm");
    expect(Number(el.getAttribute("width"))).toBeGreaterThanOrEqual(16);
    expect(Number(el.getAttribute("height"))).toBeGreaterThanOrEqual(16);
  });

  it("dims an unrecorded emotion to a readable white, not to an unreadable hue", () => {
    const { container } = render(<EmotionIcon emotion="angry" dim />);
    const el = container.querySelector("[data-emotion-icon]") as SVGSVGElement;
    expect(channels(el.style.color)).toEqual([255, 255, 255]);
    // Still legible while faded. The old dim state was `opacity-25 grayscale`
    // over a mid-luminance hue — a quarter of an already-failing colour, which
    // is not a state, it is an absence. Half-opacity white composited on the
    // panel is ~4.5:1, i.e. it still reads as an icon.
    const alpha = Number(/rgba?\([^)]*?([\d.]+)\)/.exec(el.style.color)?.[1]);
    expect(alpha).toBeGreaterThanOrEqual(0.5);
  });

  it("is decorative unless it is the only identification", () => {
    const { container } = render(<EmotionIcon emotion="sad" />);
    expect(container.querySelector("[data-emotion-icon]")).toHaveAttribute("aria-hidden", "true");
    render(<EmotionIcon emotion="sad" label="Sad emotion" />);
    expect(screen.getByRole("img", { name: "Sad emotion" })).toBeInTheDocument();
  });
});
