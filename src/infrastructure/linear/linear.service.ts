import type { ILinearClient } from '../../domain/interfaces/linear-client.interface.js';
import { LinearApiError } from '../../domain/errors/app-errors.js';
import { config } from '../../config/index.js';
import { logger } from '../logging/logger.js';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(config.linear.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: config.LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LinearApiError(`Linear API request failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new LinearApiError(`Linear API error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) {
    throw new LinearApiError('Linear API response missing data');
  }

  return json.data;
}

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
    }
  }
`;

export class LinearService implements ILinearClient {
  async postComment(ticketId: string, body: string): Promise<void> {
    await graphqlRequest(COMMENT_CREATE_MUTATION, { issueId: ticketId, body });
    logger.info('Posted Linear comment', undefined, { ticketId });
  }

  async updateStatus(ticketId: string, stateId: string): Promise<void> {
    await graphqlRequest(ISSUE_UPDATE_MUTATION, { issueId: ticketId, stateId });
    logger.info('Updated Linear issue status', undefined, { ticketId, stateId });
  }
}

export const linearService = new LinearService();
