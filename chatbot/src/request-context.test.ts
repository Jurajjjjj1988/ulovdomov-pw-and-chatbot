import { describe, it, expect } from "vitest";
import { requestContext, currentRequestId, parseTraceparent } from "./request-context.js";

describe("requestContext", () => {
  it("returns a sentinel when called outside any request", () => {
    expect(currentRequestId()).toBe("<no-context>");
  });

  it("propagates context across async boundaries", async () => {
    await requestContext.run(
      { requestId: "req-42", conversationId: "conv-abc" },
      async () => {
        expect(currentRequestId()).toBe("req-42");
        await Promise.resolve();
        expect(currentRequestId()).toBe("req-42");
      },
    );
    expect(currentRequestId()).toBe("<no-context>");
  });

  it("isolates concurrent requests", async () => {
    const calls = await Promise.all([
      requestContext.run(
        { requestId: "req-a", conversationId: "c-1" },
        async () => {
          await Promise.resolve();
          return currentRequestId();
        },
      ),
      requestContext.run(
        { requestId: "req-b", conversationId: "c-2" },
        async () => {
          await Promise.resolve();
          return currentRequestId();
        },
      ),
    ]);
    expect(calls).toEqual(["req-a", "req-b"]);
  });
});

describe("parseTraceparent", () => {
  it("parses a valid header", () => {
    const r = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(r).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
  });

  it("rejects wrong segment counts", () => {
    expect(parseTraceparent("00-tooshort")).toBeNull();
    expect(parseTraceparent("a-b-c-d-e")).toBeNull();
  });

  it("rejects wrong segment lengths", () => {
    expect(parseTraceparent("00-short-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-short-01")).toBeNull();
  });
});
