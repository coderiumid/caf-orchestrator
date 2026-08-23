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

export interface INotifier {
  notifyPipelineStarted(info: PipelineStartedNotification): Promise<void>;
  notifyPipelineComplete(info: PipelineNotification): Promise<void>;
  notifyPipelineFailed(info: PipelineFailureNotification): Promise<void>;
  notifyAgentSkipped(info: AgentSkippedNotification): Promise<void>;
  notifyAgentStarted(info: AgentStartedNotification): Promise<void>;
}
