import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// CAF-SDD-04c A2: the new minimal read ports on the real adapters.

vi.mock('../../src/config/index.js', () => ({
  config: { linear: { apiUrl: 'https://linear.test/graphql' }, LINEAR_API_KEY: 'k', github: { apiUrl: 'https://api.github.test' }, GITHUB_TOKEN: 't' },
}));
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() },
}));

const { LinearService } = await import('../../src/infrastructure/linear/linear.service.js');
const { GithubService } = await import('../../src/infrastructure/vcs/github.service.js');

describe('comment reading adapters', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('LinearService.listComments maps nodes to TicketComment, oldest first, flagging bot actors', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            comments: {
              nodes: [
                { id: 'c2', body: 'second', createdAt: '2026-01-02T00:00:00Z', botActor: { id: 'b' } },
                { id: 'c1', body: 'first', createdAt: '2026-01-01T00:00:00Z', botActor: null },
              ],
            },
          },
        },
      }),
    });

    const comments = await new LinearService().listComments('issue-uuid');

    expect(comments).toEqual([
      { id: 'c1', body: 'first', authorIsBot: false, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'c2', body: 'second', authorIsBot: true, createdAt: '2026-01-02T00:00:00Z' },
    ]);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.variables).toEqual({ issueId: 'issue-uuid' });
  });

  it('GithubService.listTicketComments maps user.type Bot to authorIsBot', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 11, body: 'hello', created_at: '2026-01-01T00:00:00Z', user: { type: 'User' } },
        { id: 12, body: 'beep', created_at: '2026-01-01T01:00:00Z', user: { type: 'Bot' } },
      ],
    });

    const comments = await new GithubService().listTicketComments({ owner: 'o', repo: 'r', issueNumber: 25 });

    expect(comments).toEqual([
      { id: '11', body: 'hello', authorIsBot: false, createdAt: '2026-01-01T00:00:00Z' },
      { id: '12', body: 'beep', authorIsBot: true, createdAt: '2026-01-01T01:00:00Z' },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain('/repos/o/r/issues/25/comments');
  });
});
