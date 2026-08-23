export interface AgentRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface IAgentRunner {
  run(agentName: string, cwd: string, prompt: string): Promise<AgentRunResult>;
}
