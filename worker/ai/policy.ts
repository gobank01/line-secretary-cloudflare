export interface AiEligibilityInput {
  newMessages: number;
  oldestAgeMinutes: number;
  hasUrgentAlert: boolean;
  budgetAvailable: boolean;
}

export function isAiEligible(input: AiEligibilityInput): boolean {
  if (!input.budgetAvailable || input.newMessages < 1) return false;
  return input.newMessages >= 5 || input.oldestAgeMinutes >= 120 || input.hasUrgentAlert;
}

export function estimateInputTokens(characters: number): number {
  return Math.max(1, Math.ceil(Math.max(0, characters) / 4));
}
