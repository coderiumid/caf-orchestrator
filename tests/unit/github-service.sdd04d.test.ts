import { describe, it, expect, vi, afterEach } from 'vitest';
import { GithubApiError } from '../../src/domain/errors/app-errors.js';

// CAF-SDD-04d: GithubService.markPullRequestReadyForReview. Fixtures only —
// the REST/GraphQL shapes below are the documented GitHub ones, not captured
// from a live call.

const configMock = { github: { apiUrl: 'https://api.github.com' }, GITHUB_TOKEN: 'test-github-token' };
vi.mock('../../src/config/index.js', () => ({ config: configMock }));
vi.mock('../../src/infrastructure/logging/logger.js', () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  configMock.github.apiUrl = 'https://api.github.com';
});

const draftPr = { number: 9, draft: true, node_id: 'PR_kwDOABC123' };
const readyPr = { number: 9, draft: false, node_id: 'PR_kwDOABC123' };
const mutationOk = { data: { markPullRequestReadyForReview: { pullRequest: { number: 9, isDraft: false } } } };

const input = { owner: 'o', repo: 'r', prNumber: 9 };
const jsonRes = (body: unknown) => ({ ok: true, json: async () => body });

async function service() {
  const { GithubService } = await import('../../src/infrastructure/vcs/github.service.js');
  return new GithubService();
}

describe('GithubService.markPullRequestReadyForReview', () => {
  it('AC-11: an already non-draft PR makes no mutation and resolves false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(readyPr));
    vi.stubGlobal('fetch', fetchMock);

    await expect((await service()).markPullRequestReadyForReview(input)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/9');
  });

  it('AC-12: a Draft reads node_id and posts the GraphQL mutation with it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(draftPr)).mockResolvedValueOnce(jsonRes(mutationOk));
    vi.stubGlobal('fetch', fetchMock);

    await expect((await service()).markPullRequestReadyForReview(input)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-github-token');
    const sent = JSON.parse(init.body);
    expect(sent.query).toContain('markPullRequestReadyForReview(input: { pullRequestId: $id })');
    expect(sent.variables).toEqual({ id: 'PR_kwDOABC123' });
  });

  it('AC-12: a GraphQL errors array (HTTP 200) throws GithubApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(draftPr))
      .mockResolvedValueOnce(jsonRes({ errors: [{ message: 'Resource not accessible by personal access token' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const call = (await service()).markPullRequestReadyForReview(input);

    await expect(call).rejects.toBeInstanceOf(GithubApiError);
    await expect(call).rejects.toThrow('Resource not accessible by personal access token');
  });

  it('AC-12: a non-2xx GraphQL response throws GithubApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(draftPr))
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Bad credentials' });
    vi.stubGlobal('fetch', fetchMock);

    await expect((await service()).markPullRequestReadyForReview(input)).rejects.toThrow('(401)');
  });

  it('AC-12: a failing GET of the PR throws GithubApiError and sends no mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'Not Found' });
    vi.stubGlobal('fetch', fetchMock);

    await expect((await service()).markPullRequestReadyForReview(input)).rejects.toBeInstanceOf(GithubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('A-1: a non-github.com host puts /graphql under the configured apiUrl', async () => {
    configMock.github.apiUrl = 'https://git.example.com/api/v3/';
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(draftPr)).mockResolvedValueOnce(jsonRes(mutationOk));
    vi.stubGlobal('fetch', fetchMock);

    await (await service()).markPullRequestReadyForReview(input);

    expect(fetchMock.mock.calls[1][0]).toBe('https://git.example.com/api/v3/graphql');
  });
});
