export type TaskAgent = 'caf-frontend' | 'caf-backend';
export type SkippableAgent = 'caf-frontend' | 'caf-backend' | 'qa' | 'reviewer' | 'documentation';

const SECTION_HEADERS: Record<TaskAgent, RegExp> = {
  'caf-frontend': /^#{1,6}\s*Frontend Tasks\s*$/im,
  'caf-backend': /^#{1,6}\s*Backend Tasks\s*$/im,
};

const DOCS_SECTION_HEADER = /^#{1,6}\s*Docs Tasks\s*$/im;
const SKIP_AGENTS_SECTION_HEADER = /^#{1,6}\s*Skip Agents\s*$/im;
const SKIP_LINE = /^-\s*(Caf-Frontend|Caf-Backend|QA|Reviewer|Documentation)\s*:\s*(.+)$/gim;

const SKIPPABLE_AGENT_NAMES: readonly SkippableAgent[] = ['caf-frontend', 'caf-backend', 'qa', 'reviewer', 'documentation'];

/**
 * Extracts the markdown body directly under `headerRegex` up to (not
 * including) the next header line, trimmed. Returns undefined if the header
 * itself isn't present at all.
 */
function sectionBody(tasksMarkdown: string, headerRegex: RegExp): string | undefined {
  const match = headerRegex.exec(tasksMarkdown);
  if (!match) return undefined;

  const rest = tasksMarkdown.slice(match.index + match[0].length);
  const nextHeader = /^#{1,6}\s/m.exec(rest);
  return (nextHeader ? rest.slice(0, nextHeader.index) : rest).trim();
}

function sectionHasContent(tasksMarkdown: string, headerRegex: RegExp): boolean {
  const body = sectionBody(tasksMarkdown, headerRegex);
  return body !== undefined && body.length > 0 && !/^\(none\)$/i.test(body);
}

export interface RouteTasksOptions {
  /**
   * When true, a section header alone isn't enough to route to that agent —
   * the body under it must have real content (not empty / not "(none)"),
   * the same rule hasDocsTasks() already applies to Docs Tasks. Off by
   * default so routeTasks()'s pre-existing behavior (header presence only)
   * is byte-for-byte unchanged for callers not opted into
   * AGENT_SKIP_ENABLED — see run-agent-pipeline.use-case.ts.
   */
  strictEmptyCheck?: boolean;
}

/**
 * Reads the planner's tasks.md and decides which implementation agent(s) to
 * run next, based on which task sections are present. A ticket can require
 * both (full-stack change) — order is frontend then backend, matching the
 * order sections typically appear.
 */
export function routeTasks(tasksMarkdown: string, options: RouteTasksOptions = {}): TaskAgent[] {
  const { strictEmptyCheck = false } = options;
  const agents: TaskAgent[] = [];

  for (const agent of ['caf-frontend', 'caf-backend'] as const) {
    const isRelevant = strictEmptyCheck
      ? sectionHasContent(tasksMarkdown, SECTION_HEADERS[agent])
      : SECTION_HEADERS[agent].test(tasksMarkdown);
    if (isRelevant) agents.push(agent);
  }

  return agents;
}

/**
 * Docs Tasks are not routed like frontend/backend (they run after, sequentially,
 * and never fail the pipeline — see run-agent-pipeline.use-case.ts). This just
 * decides whether the section has real work in it.
 */
export function hasDocsTasks(tasksMarkdown: string): boolean {
  return sectionHasContent(tasksMarkdown, DOCS_SECTION_HEADER);
}

/**
 * Parses an optional "## Skip Agents" section Planner can emit to explicitly
 * mark an agent as not relevant for this ticket, e.g.:
 *
 *   ## Skip Agents
 *   - QA: config-only change, no behavior to test
 *   - Reviewer: trivial one-line typo fix
 *
 * Parsing itself is unconditional and has no side effects — the pipeline
 * only acts on the result when AGENT_SKIP_ENABLED is true (see
 * run-agent-pipeline.use-case.ts). Fail-safe by construction: an absent
 * section, a line that doesn't match the expected "- <Agent>: <reason>"
 * shape, an unrecognized agent name, or an empty reason all simply produce
 * no entry for that agent — callers must treat "not in the map" as "don't
 * skip", never infer a skip from absence or from a parse failure.
 */
export function parseSkipDirectives(tasksMarkdown: string): Map<SkippableAgent, string> {
  const directives = new Map<SkippableAgent, string>();

  const body = sectionBody(tasksMarkdown, SKIP_AGENTS_SECTION_HEADER);
  if (!body) return directives;

  for (const match of body.matchAll(SKIP_LINE)) {
    const agentName = match[1].toLowerCase() as SkippableAgent;
    const reason = match[2].trim();
    if (!SKIPPABLE_AGENT_NAMES.includes(agentName) || reason.length === 0) continue;
    directives.set(agentName, reason);
  }

  return directives;
}
