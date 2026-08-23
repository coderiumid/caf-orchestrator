import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

// Per-project structural config (see project-registry.ts). Mirrors the shape
// of the global repo/workspace/agents fields in schema.ts, but scoped to one
// project so caf.config.yaml's `projects:` map can hold several.
export const projectConfigSchema = z.object({
  ticketPrefix: z
    .string({ error: 'ticketPrefix is required' })
    .min(1, 'ticketPrefix cannot be empty')
    .regex(/^[A-Z]+$/, 'ticketPrefix must be uppercase A-Z only, no dashes/digits/spaces'),
  repoCloneUrl: z.string({ error: 'repoCloneUrl is required' }).min(1, 'repoCloneUrl cannot be empty'),
  baseBranch: z.string({ error: 'baseBranch is required' }).min(1, 'baseBranch cannot be empty'),
  // Must be absolute — the duplicate/nested-path cross-project check below
  // only produces meaningful results when every workspaceDir is anchored to
  // the same root rather than resolved relative to an arbitrary cwd.
  workspaceDir: z
    .string({ error: 'workspaceDir is required' })
    .min(1, 'workspaceDir cannot be empty')
    .refine((v) => isAbsolute(v), { message: 'workspaceDir must be an absolute path' }),
  agents: z
    .object({
      modelOverrides: z.record(z.string(), z.string()).default({}),
    })
    .default(() => ({ modelOverrides: {} })),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

function isNestedOrEqual(a: string, b: string): boolean {
  const normA = resolve(a);
  const normB = resolve(b);
  if (normA === normB) return true;
  const rel = relative(normA, normB);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Cross-project checks that can't be expressed as per-field zod rules on a
// single project — they compare projects against each other. Attached via
// .superRefine() on the whole `projects:` map so issues from this function
// land in the same ZodError as projectConfigSchema's own per-field issues
// (verified empirically: zod v4 does not skip superRefine on a z.record just
// because one of its values has a base-schema error).
function crossProjectChecks(
  projects: Record<string, z.infer<typeof projectConfigSchema>>,
  ctx: z.RefinementCtx,
): void {
  const names = Object.keys(projects);

  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const prefix = projects[name].ticketPrefix;
    const existing = byPrefix.get(prefix);
    if (existing) {
      existing.push(name);
    } else {
      byPrefix.set(prefix, [name]);
    }
  }
  for (const [prefix, projectNames] of byPrefix) {
    if (projectNames.length > 1) {
      ctx.addIssue({
        code: 'custom' as const,
        path: [],
        message: `Duplicate ticketPrefix "${prefix}" used by projects: ${projectNames.join(', ')}`,
      });
    }
  }

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const nameA = names[i];
      const nameB = names[j];
      const dirA = projects[nameA].workspaceDir;
      const dirB = projects[nameB].workspaceDir;

      if (resolve(dirA) === resolve(dirB)) {
        ctx.addIssue({
          code: 'custom' as const,
          path: [],
          message: `Projects "${nameA}" and "${nameB}" have identical workspaceDir: "${dirA}"`,
        });
      } else if (isNestedOrEqual(dirA, dirB)) {
        ctx.addIssue({
          code: 'custom' as const,
          path: [],
          message: `workspaceDir of "${nameB}" ("${dirB}") is nested inside "${nameA}" ("${dirA}")`,
        });
      } else if (isNestedOrEqual(dirB, dirA)) {
        ctx.addIssue({
          code: 'custom' as const,
          path: [],
          message: `workspaceDir of "${nameA}" ("${dirA}") is nested inside "${nameB}" ("${dirB}")`,
        });
      }
    }
  }
}

// projects: { <projectName>: ProjectConfig } — key is the project name from
// caf.config.yaml, NOT the ticketPrefix. ProjectRegistry re-keys by prefix
// after this schema validates.
export const projectsSchema = z.record(z.string(), projectConfigSchema).superRefine(crossProjectChecks);
