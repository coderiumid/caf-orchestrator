import { config } from '../../config/index.js';

// Threshold & endpoint: satu sumber rujukan caf-initiator/.ai/tasks/CAF-PRREVIEW-01/plan.md §5.
// Jaga identik dengan versi CLI (fix-review-command.js, `gh api .../permission --jq .permission`).
// Ubah threshold di sini? Cek juga sisi caf-initiator sudah diupdate — JANGAN cuma satu sisi.
const ALLOWED_PERMISSIONS = ['write', 'maintain', 'admin'] as const;

export async function checkReviewPermission(
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  const res = await fetch(
    `${config.github.apiUrl}/repos/${owner}/${repo}/collaborators/${username}/permission`,
    {
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!res.ok) return false; // fail-closed: 404 (bukan collaborator) atau error apapun → ditolak
  const json = (await res.json()) as { permission: string };
  return ALLOWED_PERMISSIONS.includes(json.permission as (typeof ALLOWED_PERMISSIONS)[number]);
}
