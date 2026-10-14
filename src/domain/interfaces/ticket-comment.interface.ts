/**
 * A comment on a ticket (Linear issue or GitHub Issue), as the Clarify
 * resume (CAF-SDD-04c) needs it: enough to tell a human answer from a bot's
 * post and to order them. Adapters return the oldest comment first.
 */
export interface TicketComment {
  id: string;
  body: string;
  authorIsBot: boolean;
  createdAt?: string;
}
