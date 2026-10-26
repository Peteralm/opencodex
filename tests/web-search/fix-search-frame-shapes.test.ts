import { describe, expect, test } from "bun:test";
import { parseSidecarSSE } from "../../src/web-search/parse";

const response = (frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
describe("search SSE field shapes", () => {
  test.each([7, {}, [], true])("ignores a non-string event type: %j", async type => {
    const result = await parseSidecarSSE(response([{ type }, { type: "response.output_text.delta", delta: "kept" }, { type: "response.completed" }]));
    expect(result).toEqual({ text: "kept", sources: [] });
  });
  test.each([{}, "invalid", 7])("keeps deltas if terminal output is not an array: %j", async output => {
    const result = await parseSidecarSSE(response([{ type: "response.output_text.delta", delta: "kept" }, { type: "response.completed", response: { output } }]));
    expect(result.text).toBe("kept");
  });
  test("skips null output/content entries and non-array annotations", async () => {
    const result = await parseSidecarSSE(response([{ type: "response.completed", response: { output: [
      null, 7, { type: "message", content: [null, false, { type: "output_text", text: "kept", annotations: {} }] },
    ] } }]));
    expect(result).toEqual({ text: "kept", sources: [] });
  });
  test("does not expose non-string error messages", async () => {
    const result = await parseSidecarSSE(response([{ type: "response.failed", response: { error: { message: { raw: true } } } }]));
    expect(result.error).toBe("sidecar stream ended with response.failed");
  });
});
