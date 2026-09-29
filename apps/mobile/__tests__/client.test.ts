import { createApiClient, RENEWED_TOKEN_HEADER } from "../src/api/client";

// TS-94: the mobile client must pick up a token the server re-issued (sliding renewal), and send
// the current stored token on every request.
function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("createApiClient session renewal", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("hands a renewed token to onRenewedToken and sends it on the next request", async () => {
    let stored = "old-token";
    const seenAuth: string[] = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      seenAuth.push((init?.headers as Record<string, string>).Authorization);
      return seenAuth.length === 1
        ? respond(200, { ok: true }, { [RENEWED_TOKEN_HEADER]: "new-token" })
        : respond(200, { ok: true });
    }) as typeof fetch;

    const api = createApiClient(
      "http://api.test",
      async () => stored,
      async (token) => {
        stored = token;
      }
    );
    await api.get("/api/v1/weddings");
    await api.get("/api/v1/weddings");

    expect(seenAuth).toEqual(["Bearer old-token", "Bearer new-token"]);
  });

  it("still keeps a renewed token when that response is an error", async () => {
    const renewedTokens: string[] = [];
    global.fetch = jest.fn(async () =>
      respond(404, { error: "Not found" }, { [RENEWED_TOKEN_HEADER]: "new-token" })
    ) as typeof fetch;

    const api = createApiClient("http://api.test", async () => "old-token", async (t) => {
      renewedTokens.push(t);
    });
    await expect(api.get("/api/v1/weddings/missing")).rejects.toMatchObject({ status: 404 });
    expect(renewedTokens).toEqual(["new-token"]);
  });

  it("does nothing extra when the server sends no renewal", async () => {
    const onRenewed = jest.fn();
    global.fetch = jest.fn(async () => respond(200, { ok: true })) as typeof fetch;
    const api = createApiClient("http://api.test", async () => "tok", onRenewed);
    await api.get("/api/v1/weddings");
    expect(onRenewed).not.toHaveBeenCalled();
  });
});
