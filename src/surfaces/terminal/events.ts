/**
 * The events of `GET /api/chat/stream` and the bodies of the two chat POST routes.
 * The chat program and any later page read the same shapes.
 */

export const CHAT_STREAM_PATH = '/api/chat/stream';
export const CHAT_MESSAGE_PATH = '/api/chat/message';
/** `:id` is the approval request id. */
export const CHAT_APPROVAL_PATH = '/api/chat/approvals/:id';

/** Event `message`: a message from the agent for a mission. */
export interface ChatMessageEvent {
  missionId: string | null;
  /** `<agent name> · <mission name>` (§F.1). */
  label: string;
  text: string;
  /** A file from the mission's `data/` folder that goes with the message. */
  filePath?: string;
  /** ISO time at which the harness sent the message. */
  sentAt: string;
  /** True for a message kept while no chat program was connected. */
  earlier?: true;
}

/** Event `notice`: a text from the harness that concerns no mission. */
export interface ChatNoticeEvent {
  /** Empty for a notice of the terminal surface itself, such as "The harness is stopping." */
  label: string;
  text: string;
  sentAt: string;
  earlier?: true;
}

/** Event `approval`: a request that waits for the user (§G). */
export interface ChatApprovalEvent {
  id: string;
  missionId: string;
  label: string;
  /** The request rendered by `describeApproval`. */
  text: string;
  createdAt: string;
  expiresAt: string;
}

/** Event `approval_closed`: a request that no longer waits. */
export interface ChatApprovalClosedEvent {
  id: string;
  /** Such as `approved`, `rejected: too long` or `cancelled: no answer in 24 hours`. */
  outcome: string;
}

export interface ChatMessageBody {
  text: string;
}

export interface ChatApprovalBody {
  decision: 'approve' | 'reject';
  reason?: string;
}

export interface ChatApprovalReply {
  /** False when the request was no longer waiting, so the answer changed nothing. */
  wasWaiting: boolean;
}
