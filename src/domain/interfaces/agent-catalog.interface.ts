/**
 * Which agent definitions a target repo ships (CAF-SDD-04a). The pipeline
 * picks its validation gate (`caf-validator` vs `caf-qa`) and decides whether
 * the documentation step can run from this, instead of from config.
 */
export interface IAgentCatalog {
  /** True when the checkout at `repoPath` has `.claude/agents/<agentName>.md`. Never throws: anything unreadable is `false`. */
  hasAgent(repoPath: string, agentName: string): Promise<boolean>;
}
