import { createApp } from "./app";
import type { AppEnv } from "./env";
import { runScheduled } from "./scheduler/coordinator";

export { GroupSummarizer } from "./workflows/group-summarizer";

const app = createApp();

export default {
  fetch(request: Request, env: AppEnv, context: ExecutionContext) {
    return app.fetch(request, env, context);
  },
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    context.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<AppEnv>;
