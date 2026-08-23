export interface ILinearClient {
  postComment(ticketId: string, body: string): Promise<void>;
  updateStatus(ticketId: string, stateId: string): Promise<void>;
}
