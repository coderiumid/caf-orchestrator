import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/config/index.js', () => ({
  config: { github: { apiUrl: 'https://api.github.com' }, GITHUB_TOKEN: 'test-github-token' },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GithubService.listReviewComments', () => {
  it('normalizes the REST API\'s explicit `in_reply_to_id: null` (thread-starter) to undefined', async () => {
    // GET /pulls/{number}/comments sets in_reply_to_id explicitly to `null` for
    // a thread-starter comment — unlike the webhook payload, which omits the
    // key entirely. See plan-checkpoint-b.md poin 0.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 1, body: 'thread starter', path: 'a.ts', line: 1, in_reply_to_id: null },
          { id: 2, body: 'a reply', path: 'a.ts', line: 1, in_reply_to_id: 1 },
        ],
      }),
    );

    const { GithubService } = await import('../../src/infrastructure/vcs/github.service.js');
    const comments = await new GithubService().listReviewComments('o', 'r', 1);

    expect(comments[0].inReplyToId).toBeUndefined();
    expect(comments[1].inReplyToId).toBe(1);

    // Regression guard for the caller's filter contract (webhooks.ts mode 'global').
    const inlineEntries = comments.filter((c) => c.inReplyToId === undefined);
    expect(inlineEntries.map((c) => c.id)).toEqual([1]);
  });
});

describe('GithubService.replyToReviewComment', () => {
  it('calls the pull-request-scoped reply endpoint including the PR number', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const { GithubService } = await import('../../src/infrastructure/vcs/github.service.js');
    await new GithubService().replyToReviewComment({
      owner: 'o',
      repo: 'r',
      prNumber: 42,
      commentId: 99,
      body: 'FIXED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/pulls/42/comments/99/replies');
  });
});
