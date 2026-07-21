export type CoachingMonitorHealthResult = {
  storedMessagesBeforeReply: number;
  storedMessagesAfterReply: number;
  firstChunkMs: number | null;
  chatTotalMs: number;
  hasDone: boolean;
  outputChars: number;
  returnedFallback: boolean;
  provider: string;
  fallbackFrom: string | null;
  completionStatus: string | null;
  finalizationStatus: string | null;
  cookieAuthUsed: boolean;
};

export function assertHealthyCoachingMonitorResult(
  result: CoachingMonitorHealthResult,
  limits: { maxFirstChunkMs: number; maxTotalMs: number }
) {
  if (!result.cookieAuthUsed) {
    throw new Error('monitor did not use paid cookie authentication');
  }
  if (!result.hasDone) {
    throw new Error('monitor did not receive done event');
  }
  if (result.completionStatus !== 'complete') {
    throw new Error(
      `monitor received incomplete AI result: ${
        result.completionStatus || 'missing status'
      }`
    );
  }
  if (result.finalizationStatus !== 'complete') {
    throw new Error(
      `monitor did not complete chat metadata: ${
        result.finalizationStatus || 'missing status'
      }`
    );
  }
  if (
    result.firstChunkMs === null ||
    result.firstChunkMs > limits.maxFirstChunkMs
  ) {
    throw new Error(`monitor first chunk too slow: ${result.firstChunkMs}ms`);
  }
  if (result.chatTotalMs > limits.maxTotalMs) {
    throw new Error(`monitor chat response too slow: ${result.chatTotalMs}ms`);
  }
  if (result.outputChars < 8) {
    throw new Error(`monitor output too short: ${result.outputChars} chars`);
  }
  if (result.storedMessagesAfterReply !== result.storedMessagesBeforeReply + 1) {
    throw new Error('monitor did not persist the complete conversation');
  }
}
