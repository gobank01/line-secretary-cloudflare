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

export function estimateInputTokens(characters: number): number {
  return Math.max(1, Math.ceil(Math.max(0, characters) / 4));
}
