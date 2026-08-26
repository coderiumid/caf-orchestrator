export interface AgentRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface IAgentRunner {
  /** modelOverride, when set, takes precedence over the global agents.modelOverrides[agentName] entry (per-project override). */
  run(agentName: string, cwd: string, prompt: string, modelOverride?: string): Promise<AgentRunResult>;
}
