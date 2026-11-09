import { createAuthClient } from "better-auth/react";

import { getAppUrl } from "./env";

export const authClient = createAuthClient({
  baseURL: getAppUrl(),
}) as ReturnType<typeof createAuthClient>;
