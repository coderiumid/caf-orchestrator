import type { TicketComment } from './ticket-comment.interface.js';

export interface ILinearClient {
  postComment(ticketId: string, body: string): Promise<void>;
  updateStatus(ticketId: string, stateId: string): Promise<void>;
  // CAF-SDD-04c: the ticket's comments, oldest first — the answers to a Clarify.
  listComments(ticketId: string): Promise<TicketComment[]>;
}
