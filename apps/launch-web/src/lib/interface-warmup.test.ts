import { afterEach, describe, expect, it, vi } from "vitest";

import { warmInterfaceDocument } from "./interface-warmup";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interface document warm-up", () => {
  it("preconnects and primes the cache for a trusted immutable document", () => {
    const appendChild = vi.fn();
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ href: "", rel: "" })),
      head: { appendChild },
    });
    vi.stubGlobal("fetch", fetchMock);

    warmInterfaceDocument(
      "https://interfaces.connectgalactic.com/i/app-test/unique-content-hash-a",
    );

    expect(appendChild).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://interfaces.connectgalactic.com/i/app-test/unique-content-hash-a",
      expect.objectContaining({ cache: "force-cache", mode: "no-cors" }),
    );
  });

  it("does not fetch an untrusted interface origin", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ href: "", rel: "" })),
      head: { appendChild: vi.fn() },
    });
    vi.stubGlobal("fetch", fetchMock);

    warmInterfaceDocument("https://example.com/interface.html");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
