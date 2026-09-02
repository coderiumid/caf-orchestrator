export interface PipelineNotification {
  jobId: string;
  ticketKey: string;
  durationMs: number;
  branch: string;
}

export interface PipelineFailureNotification {
  jobId: string;
  ticketKey: string;
  errorMessage: string;
}

export interface PipelineNeedsHumanNotification {
  jobId: string;
  ticketKey: string;
  reason: string;
}

export interface PipelineStartedNotification {
  jobId: string;
  ticketKey: string;
  ticketTitle: string;
}

export interface AgentSkippedNotification {
  jobId: string;
  ticketKey: string;
  agentName: string;
  reason: string;
}

export interface AgentStartedNotification {
  jobId: string;
  ticketKey: string;
  agentName: string;
}

export interface PrReviewStartedNotification {
  jobId: string;
  ticketKey: string;
  prNumber: number;
  repoFullName: string;
  mode: string;
}

export interface PrReviewCompletedNotification {
  jobId: string;
  ticketKey: string;
  prNumber: number;
  repoFullName: string;
  mode: string;
  entryCount: number;
}

export interface PrReviewFailedNotification {
  jobId: string;
  ticketKey: string;
  prNumber: number;
  repoFullName: string;
  errorMessage: string;
}

export interface INotifier {
  notifyPipelineStarted(info: PipelineStartedNotification): Promise<void>;
  notifyPipelineComplete(info: PipelineNotification): Promise<void>;
  notifyPipelineFailed(info: PipelineFailureNotification): Promise<void>;
  notifyPipelineNeedsHuman(info: PipelineNeedsHumanNotification): Promise<void>;
  notifyAgentSkipped(info: AgentSkippedNotification): Promise<void>;
  notifyAgentStarted(info: AgentStartedNotification): Promise<void>;
  notifyPrReviewStarted(info: PrReviewStartedNotification): Promise<void>;
  notifyPrReviewCompleted(info: PrReviewCompletedNotification): Promise<void>;
  notifyPrReviewFailed(info: PrReviewFailedNotification): Promise<void>;
}
