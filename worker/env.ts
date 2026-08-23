export interface GroupSummarizerParams {
  groupId: string;
  scheduledFor: number;
  jobRunId?: number;
}

export interface AppEnv {
  DB: D1Database;
  GROUP_SUMMARIZER: Workflow<GroupSummarizerParams>;
  APP_ENV: string;
  APP_TIMEZONE: string;
  OPENROUTER_MODEL: string;
  REAL_GROUP_LIMIT: string;
  AUTOMATED_MONTHLY_PUSH_CAP: string;
  AI_DAILY_CALL_CAP: string;
  AI_DAILY_INPUT_TOKEN_CAP: string;
  AI_MIN_MESSAGES: string;
  AI_MAX_WAIT_MINUTES: string;
  LINE_PUSH_ENABLED: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  OWNER_USER_ID: string;
  OPENROUTER_API_KEY: string;
  DASHBOARD_PASSWORD: string;
  SESSION_SECRET: string;
  DASHBOARD_URL: string;
}
