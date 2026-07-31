import { afterEach, describe, expect, it, vi } from "vitest";

import { LaunchApiClient } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("candidate invitation API client", () => {
  it("binds manual deployment to the reviewed archive and release", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        agent: null,
        candidateId: "candidate/1",
        deploymentId: "deployment-1",
        generatedAt: "2026-07-30T00:00:00.000Z",
        message: "Pending",
        replayed: false,
        status: "pending",
        success: true,
      }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LaunchApiClient({
      baseUrl: "https://api.example.test",
      getAuthToken: () => "owner-token",
    });
    const request = {
      archiveDigest: "a".repeat(64),
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      releaseDigest: "b".repeat(64),
      reviewRevision: "review-1",
    };

    await client.deployCandidate("candidate/1", request);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.example.test/api/launch/candidates/candidate%2F1/deploy",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it("creates and reconciles a durable opaque checkout attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          attemptId: "attempt-1",
          generatedAt: "2026-07-30T00:00:00.000Z",
          status: "pending",
          url: "https://checkout.stripe.test/session",
        }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          attemptId: "attempt-1",
          generatedAt: "2026-07-30T00:00:01.000Z",
          status: "active",
          subscription: {},
        }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          attemptId: "attempt-1",
          generatedAt: "2026-07-30T00:00:02.000Z",
          status: "cancelled",
          subscription: {},
        }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new LaunchApiClient({
      baseUrl: "https://api.example.test",
      getAuthToken: () => "owner-token",
    });

    await client.createSubscriptionCheckout(
      "https://app.example.test/?subscription=return",
      "22222222-2222-4222-8222-222222222222",
    );
    await client.subscriptionCheckoutAttempt("attempt/1");
    await client.cancelSubscriptionCheckoutAttempt("attempt/1");

    const [checkoutUrl, checkoutInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(checkoutUrl).toBe(
      "https://api.example.test/api/launch/subscription/checkout",
    );
    expect(JSON.parse(String(checkoutInit.body))).toEqual({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      plan: "pro",
      returnUrl: "https://app.example.test/?subscription=return",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.example.test/api/launch/subscription/checkout-attempts/attempt%2F1",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.example.test/api/launch/subscription/checkout-attempts/attempt%2F1/cancel",
    );
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });
});
