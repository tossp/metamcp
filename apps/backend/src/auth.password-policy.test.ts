import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { database, settings, checkBasicAuth } = vi.hoisted(() => {
  vi.stubEnv("NODE_ENV", "test");
  const settings = { basicAuthDisabled: true };
  return {
    database: {
      user: [] as Record<string, unknown>[],
      account: [] as Record<string, unknown>[],
      session: [] as Record<string, unknown>[],
      verification: [] as Record<string, unknown>[],
    },
    settings,
    checkBasicAuth: vi.fn(async () => settings.basicAuthDisabled),
  };
});

vi.mock("./db/index", () => ({ db: {} }));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(database) };
});
vi.mock("./lib/config.service", () => ({
  configService: {
    isBasicAuthDisabled: checkBasicAuth,
    isSignupDisabled: async () => false,
    isSsoSignupDisabled: async () => false,
  },
}));
vi.mock("./utils/logger", () => ({ default: { info: vi.fn() } }));

const origin = "http://localhost:12008";
const credentials = {
  name: "Password policy test",
  email: "password-policy@example.test",
  password: "test-only-password-12345",
};
let auth: (typeof import("./auth"))["auth"];

beforeAll(async () => {
  for (const [key, value] of Object.entries({
    BETTER_AUTH_SECRET: "test-only-password-policy-secret-123456789",
    APP_URL: origin,
    OIDC_CLIENT_ID: "",
    OIDC_CLIENT_SECRET: "",
    OIDC_DISCOVERY_URL: "",
    EXTRA_TRUSTED_ORIGINS: "",
    BETTER_AUTH_SESSION_EXPIRES_IN_SECONDS: "",
    BETTER_AUTH_SESSION_UPDATE_AGE_SECONDS: "",
  })) {
    vi.stubEnv(key, value);
  }
  ({ auth } = await import("./auth"));
});

beforeEach(() => {
  for (const rows of Object.values(database)) rows.length = 0;
  settings.basicAuthDisabled = true;
  checkBasicAuth.mockClear();
});

afterAll(() => vi.unstubAllEnvs());

describe("password authentication policy through the real auth handler", () => {
  it("rejects local signup without creating a user, credential or session", async () => {
    await expectBlocked(await post("/sign-up/email", credentials));
    for (const rows of Object.values(database)) expect(rows).toHaveLength(0);
    expect(checkBasicAuth).toHaveBeenCalledOnce();
  });

  it("rejects an existing account's correct password after disabling login", async () => {
    settings.basicAuthDisabled = false;
    expect((await post("/sign-up/email", credentials)).status).toBe(200);
    const snapshot = structuredClone(database);

    settings.basicAuthDisabled = true;
    await expectBlocked(await post("/sign-in/email", credentials));
    expect(database).toEqual(snapshot);
  });

  it("keeps password login available when the switch is turned off again", async () => {
    settings.basicAuthDisabled = false;
    expect((await post("/sign-up/email", credentials)).status).toBe(200);
    const userId = database.user[0]?.id;

    settings.basicAuthDisabled = true;
    await expectBlocked(await post("/sign-in/email", credentials));
    settings.basicAuthDisabled = false;
    const response = await post("/sign-in/email", credentials);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      token: expect.any(String),
      user: { id: userId },
    });
    expect(database.user).toHaveLength(1);
  });

  it.each([
    ["/request-password-reset", { email: credentials.email }],
    [
      "/reset-password",
      { newPassword: "new-test-password", token: "test-token" },
    ],
    [
      "/change-password",
      {
        currentPassword: credentials.password,
        newPassword: "new-test-password",
      },
    ],
  ])("rejects the public password operation %s", async (path, body) => {
    await expectBlocked(await post(path as string, body));
    for (const rows of Object.values(database)) expect(rows).toHaveLength(0);
  });

  it("rejects password reset callbacks without redirecting to a reset form", async () => {
    const response = await auth.handler(
      new Request(
        `${origin}/api/auth/reset-password/test-token?callbackURL=${encodeURIComponent(`${origin}/login`)}`,
      ),
    );
    await expectBlocked(response);
    expect(response.headers.has("location")).toBe(false);
  });

  it("rejects the server-only password verification operation", async () => {
    await expect(
      auth.api.verifyPassword({
        body: { password: credentials.password },
        headers: new Headers({ Origin: origin }),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      body: { code: "PASSWORD_AUTH_DISABLED" },
    });
  });

  it("does not expose a public set-password endpoint", async () => {
    expect(
      (await post("/set-password", { newPassword: credentials.password }))
        .status,
    ).toBe(404);
  });

  it("keeps session lookup and logout working without consulting password policy", async () => {
    settings.basicAuthDisabled = false;
    const signup = await post("/sign-up/email", credentials);
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    settings.basicAuthDisabled = true;
    checkBasicAuth.mockClear();

    const session = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { email: credentials.email },
    });
    expect((await post("/sign-out", {}, cookie)).status).toBe(200);
    expect(database.session).toHaveLength(0);
    expect(checkBasicAuth).not.toHaveBeenCalled();
  });
});

function post(path: string, body: unknown, cookie?: string) {
  return auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function expectBlocked(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: "PASSWORD_AUTH_DISABLED",
  });
  expect(response.headers.has("set-cookie")).toBe(false);
}
