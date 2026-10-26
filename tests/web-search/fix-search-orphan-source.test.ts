import { describe, expect, test } from "bun:test";
import { parseSidecarSSE } from "../../src/web-search/parse";

async function parse(text: string) {
  return parseSidecarSSE(new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  } })}\n\n`));
}
describe("search source-list text ownership", () => {
  test("preserves a trailing bullet without a URL", async () => {
    const result = await parse("Answer\n\nSources:\n- https://example.com\n- Remember this conclusion");
    expect(result.text).toBe("Answer\n\n- Remember this conclusion");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("does not swallow consecutive unmatched bullets before another URL", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- First note\n- Second note\nhttps://example.org");
    expect(result.text).toContain("- First note\n- Second note\nhttps://example.org");
    expect(result.sources).toHaveLength(1);
  });
  test("preserves a pending note when the next citation has its own title", async () => {
    const result = await parse("Answer\nSources:\n- https://example.com\n- Keep this note\n- Another source: https://example.org");
    expect(result.text).toBe("Answer\n\n- Keep this note\n- Another source: https://example.org");
    expect(result.sources).toEqual([{ url: "https://example.com" }]);
  });
  test("still consumes a title followed immediately by its URL", async () => {
    const result = await parse("Answer\nSources:\n- A title\nhttps://example.com\n\nConclusion");
    expect(result.text).toBe("Answer\n\nConclusion");
    expect(result.sources).toEqual([{ title: "A title", url: "https://example.com" }]);
  });
});
