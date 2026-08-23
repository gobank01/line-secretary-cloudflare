import type { AppEnv } from "../worker/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }

    interface GlobalProps {
      mainModule: typeof import("../worker/index");
    }
  }
}

export {};
