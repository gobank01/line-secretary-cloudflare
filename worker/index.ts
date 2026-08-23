import { createApp } from "./app";
import type { AppEnv } from "./env";

const app = createApp();

export default {
  fetch(request: Request, env: AppEnv, context: ExecutionContext) {
    return app.fetch(request, env, context);
  },
  scheduled(_controller: ScheduledController, _env: AppEnv, _context: ExecutionContext) {},
} satisfies ExportedHandler<AppEnv>;

