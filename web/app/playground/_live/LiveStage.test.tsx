// The Live stage's honesty rules, which are all about what it says BEFORE you
// press Talk: a disabled conversational surface, a capped service ("line busy"),
// a render already running, an agent with no installed voice, and a scripted
// brain that cannot follow your scene note. Every one of them used to be
// discoverable only by dialling and failing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import LiveStage from "./LiveStage";
import type { Character } from "@/app/voices/_data/characters";

afterEach(() => { vi.unstubAllGlobals(); });

const CHARACTERS = [
  {
    character_id: "nova", name: "Nova", category: "cloned", tags: [], lang: "en",
    voices: [{ voice_id: "v_nova_base", character_id: "nova", emotion: "baseline", name: "Nova", category: "cloned", lang: "en" }],
    emotions: ["baseline"], coverage: 1, total: 8,
  },
  {
    character_id: "atlas", name: "Atlas", category: "cloned", tags: [], lang: "en",
    voices: [], emotions: [], coverage: 0, total: 8,
  },
] as unknown as Character[];

type Info = {
  agents: unknown[];
  brain: { backend: string };
  enabled: boolean;
  sessions: { active: number; max: number };
};

const AGENT = {
  agent_id: "interviewer", name: "Interviewer", language: "en", first_message: "Hello.",
  scripted_turns: 2, allow_overrides: ["prompt", "first_message", "language", "voice_id"],
  speakable: true,
};

function stubInfo(info: Partial<Info> & Record<string, unknown> = {}) {
  const body: Info = {
    agents: [AGENT], brain: { backend: "openai-compat" }, enabled: true,
    sessions: { active: 0, max: 2 }, ...info,
  } as Info;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" },
  })));
}

function mount(props: Partial<React.ComponentProps<typeof LiveStage>> = {}) {
  return render(
    <LiveStage
      characters={CHARACTERS}
      charId="nova"
      generateBusy={false}
      onTake={props.onTake ?? vi.fn()}
      onScript={props.onScript ?? vi.fn()}
      {...props}
    />,
  );
}

const talk = () => screen.getByRole("button", { name: /talk/i });

describe("LiveStage — what it says before you dial", () => {
  it("shows the brain and the service's own session count", async () => {
    stubInfo({ sessions: { active: 1, max: 4 } });
    mount();
    expect(await screen.findByText(/brain · openai-compat/)).toBeInTheDocument();
    expect(screen.getByText("1/4 lines")).toBeInTheDocument();
  });

  it("refuses when conversational agents are disabled on the service", async () => {
    stubInfo({ enabled: false });
    mount();
    await waitFor(() => expect(talk()).toBeDisabled());
    expect(talk()).toHaveAttribute("title", expect.stringContaining("CONVAI_ENABLED=0"));
  });

  it("says LINE BUSY when the service is already at its session cap", async () => {
    // The cap is an honest answer, not a failure — and it is said in the same
    // words the socket's 1013 close uses.
    stubInfo({ sessions: { active: 2, max: 2 } });
    mount();
    await waitFor(() => expect(talk()).toBeDisabled());
    expect(talk()).toHaveAttribute("title", expect.stringContaining("Line busy"));
  });

  it("refuses to dial while the engine is rendering a take", async () => {
    stubInfo();
    mount({ generateBusy: true });
    await waitFor(() => expect(talk()).toBeDisabled());
    expect(talk()).toHaveAttribute("title", expect.stringContaining("same cores"));
  });

  it("names the agent's own problem when it has no voice this service can speak", async () => {
    stubInfo({
      agents: [{ ...AGENT, speakable: false, problem: "no Piper voice for 'cs' is installed" }],
    });
    mount();
    await waitFor(() => expect(talk()).toBeDisabled());
    expect(talk()).toHaveAttribute("title", expect.stringContaining("no Piper voice"));
  });

  it("is dialable, and reports the Character's voice, on a healthy service", async () => {
    stubInfo();
    mount();
    await waitFor(() => expect(talk()).toBeEnabled());
    expect(screen.getByText("Nova")).toBeInTheDocument();
    expect(screen.getByText(/answers in this Character's voice/)).toBeInTheDocument();
  });

  it("says a Character with no recorded voice cannot lend one", async () => {
    stubInfo();
    mount({ charId: "atlas" });
    await waitFor(() => expect(talk()).toBeEnabled());
    expect(screen.getByText(/no recorded voice yet/)).toBeInTheDocument();
  });

  it("always recommends headphones (there is no echo cancellation)", async () => {
    stubInfo();
    mount();
    expect(await screen.findByText(/Headphones recommended/)).toBeInTheDocument();
  });

  it("warns that a SCRIPTED brain cannot follow a scene note or a script", async () => {
    stubInfo({ brain: { backend: "scripted" } });
    mount();
    // The chip says which brain answered; the advisory says what that COSTS.
    expect(await screen.findByText(/brain · scripted/)).toBeInTheDocument();
    expect(screen.getByText(/cannot change what it/)).toBeInTheDocument();
    expect(screen.getByText(/CONVAI_LLM/)).toBeInTheDocument();
  });

  it("disables the scene note when the agent refuses prompt overrides", async () => {
    stubInfo({ agents: [{ ...AGENT, allow_overrides: [] }] });
    mount();
    const scene = await screen.findByLabelText("Scene note");
    await waitFor(() => expect(scene).toBeDisabled());
    expect(scene).toHaveAttribute("placeholder", expect.stringContaining("refuses prompt overrides"));
    // …and says the agent will use its own voice when THAT is refused too.
    expect(screen.getByText(/speaks in its own voice/)).toBeInTheDocument();
  });

  it("offers 'rehearse this script' only when the composer has lines", async () => {
    stubInfo();
    const { unmount } = mount();
    await waitFor(() => expect(talk()).toBeEnabled());
    expect(screen.queryByRole("button", { name: /rehearse/i })).toBeNull();
    unmount();

    stubInfo();
    mount({ scriptLines: [{ id: "l1", characterId: "nova", text: "Hello there." }] });
    await waitFor(() => expect(screen.getByRole("button", { name: /rehearse/i })).toBeEnabled());
  });

  it("reports a conversational surface it could not read at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: "backend unreachable" }), { status: 503 })));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("backend unreachable");
    expect(talk()).toBeDisabled();
  });
});
