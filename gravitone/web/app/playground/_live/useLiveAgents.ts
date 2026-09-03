"use client";

// What this service's conversational surface actually is, read once on mount:
// which agents are installed, which brain answers for them, and how many lines
// the replica is already holding. Every refusal the stage says BEFORE you press
// Talk is derived from this.

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";

/** What the service says about its own conversational surface. */
export type AgentsInfo = {
  agents: Array<{
    agent_id: string;
    name: string;
    language: string;
    first_message: string;
    scripted_turns: number;
    allow_overrides: string[];
    speakable: boolean;
    problem?: string;
    voice_id?: string | null;
  }>;
  brain: { backend: string; model?: string };
  enabled: boolean;
  sessions: { active: number; max: number };
};

export function useLiveAgents() {
  const mounted = useMounted();
  const [info, setInfo] = useState<AgentsInfo | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");

  // What the service can actually do, read once. A failure here is reported —
  // "no agents" and "we could not ask" are different sentences.
  useEffect(() => {
    const ctrl = new AbortController();
    apiJson<AgentsInfo>("/api/convai/agents", { cache: "no-store", signal: ctrl.signal },
      "the conversational surface could not be read")
      .then((j) => {
        if (ctrl.signal.aborted || !mounted.current) return;
        setInfo(j);
        setAgentId((cur) => cur || j.agents.find((a) => a.speakable)?.agent_id || j.agents[0]?.agent_id || "");
      })
      .catch((e) => {
        if (ctrl.signal.aborted || !mounted.current) return;
        setInfoErr(e instanceof Error ? e.message : "the conversational surface could not be read");
      });
    return () => ctrl.abort();
  }, [mounted]);

  const agent = info?.agents.find((a) => a.agent_id === agentId);

  return { info, infoErr, agentId, setAgentId, agent };
}
