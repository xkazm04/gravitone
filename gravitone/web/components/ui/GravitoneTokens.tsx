import { tokensCss } from "./tokens";

/**
 * Publishes the design system (tokens.ts) as CSS custom properties on :root,
 * plus the Signal Layer channel defaults (contract C4). Rendered once, in
 * layout.tsx, ahead of everything else.
 *
 * Why a style tag rather than more CSS in globals.css: tokens.ts is the source
 * of truth and it is TypeScript — components import the same constants they
 * render with. Emitting the rule from those constants makes drift impossible
 * instead of merely discouraged.
 *
 * Server-rendered, so the values are present in the first paint (no flash) and
 * the vars resolve even if JS never runs.
 */
export default function GravitoneTokens() {
  return <style id="gravitone-tokens" dangerouslySetInnerHTML={{ __html: tokensCss() }} />;
}
