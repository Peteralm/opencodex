import { expect, test } from "bun:test";
import { isAntigravityModelNotFoundRefusal } from "../../src/server/responses/antigravity-validation-refusal";

test("CCA model 404 classification requires a complete bounded exact refusal", async () => {
  const text = "Requested entity was not found.";
  expect(await isAntigravityModelNotFoundRefusal(new Response(text, { status: 404 }))).toBe(true);
  for (const status of [400, 401, 403, 429, 500])
    expect(await isAntigravityModelNotFoundRefusal(new Response(text, { status }))).toBe(false);
  for (const body of ["not found", "Requested entity is missing", "x".repeat(4097) + text, text + "x".repeat(4097)])
    expect(await isAntigravityModelNotFoundRefusal(new Response(body, { status: 404 }))).toBe(false);
  expect(await isAntigravityModelNotFoundRefusal(new Response(text, { status: 404 }), AbortSignal.abort())).toBe(false);
});

test("an incomplete model 404 stream cannot authorize rotation", async () => {
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("Requested entity was not found.")); },
    cancel() {},
  }), { status: 404 });
  expect(await isAntigravityModelNotFoundRefusal(response)).toBe(false);
  await response.body?.cancel();
});
