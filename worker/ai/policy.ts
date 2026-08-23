export interface AiEligibilityInput {
  newMessages: number;
  oldestAgeMinutes: number;
  hasUrgentAlert: boolean;
  budgetAvailable: boolean;
}

export function isAiEligible(
  input: AiEligibilityInput,
  thresholds: { minimumMessages: number; maximumWaitMinutes: number } = {
    minimumMessages: 5,
    maximumWaitMinutes: 120,
  },
): boolean {
  if (!input.budgetAvailable || input.newMessages < 1) return false;
  return (
    input.newMessages >= thresholds.minimumMessages ||
    input.oldestAgeMinutes >= thresholds.maximumWaitMinutes ||
    input.hasUrgentAlert
  );
}

export function estimateInputTokens(text: string): number {
  // UTF-8 bytes are a deliberately conservative upper bound for byte-fallback tokenizers,
  // including Thai text where a characters/4 estimate can severely under-reserve.
  return Math.max(1, new TextEncoder().encode(text).byteLength);
}
