import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IAgentCatalog } from '../../domain/interfaces/agent-catalog.interface.js';

// Same shape as every `--agent` name the pipeline spawns (KNOWN_AGENT_NAMES) —
// anything else (a path separator, `..`) is rejected before touching the
// filesystem, so a lookup can never leave `.claude/agents/`.
const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** IAgentCatalog over the cloned workspace: an agent exists when `.claude/agents/<name>.md` is a file there. */
export class WorkspaceAgentCatalog implements IAgentCatalog {
  async hasAgent(repoPath: string, agentName: string): Promise<boolean> {
    if (!AGENT_NAME.test(agentName)) return false;
    try {
      return (await stat(join(repoPath, '.claude', 'agents', `${agentName}.md`))).isFile();
    } catch {
      return false;
    }
  }
}
