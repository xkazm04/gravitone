import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBanner } from "./ErrorBanner";

describe("ErrorBanner", () => {
  it("renders nothing when there is no message", () => {
    const { container } = render(<ErrorBanner>{null}</ErrorBanner>);
    expect(container).toBeEmptyDOMElement();
  });

  it("is announced to assistive tech", () => {
    render(<ErrorBanner>clone failed</ErrorBanner>);
    expect(screen.getByRole("alert")).toHaveTextContent("clone failed");
  });

  it("errors are rose and warnings are amber — severity must be readable from colour", () => {
    // Before this component, amber meant BOTH error and warning depending on
    // the file, so users could not tell severity apart.
    const { container: err } = render(<ErrorBanner>failed</ErrorBanner>);
    expect(err.firstElementChild?.className).toContain("rose");
    expect(err.firstElementChild?.className).not.toContain("amber");

    const { container: warn } = render(
      <ErrorBanner severity="warning">degraded</ErrorBanner>);
    expect(warn.firstElementChild?.className).toContain("amber");
    expect(warn.firstElementChild?.className).not.toContain("rose");
  });
});
