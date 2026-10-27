import { describe, expect, test } from "bun:test";
import { coerceIntegerToolArguments } from "../../src/lib/tool-argument-integers";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";
const schema = { type: "object", properties: { count: { type: "integer" }, label: { type: "string" } } };

describe("tool argument numeric preservation", () => {
  test.each(["9007199254740993", "-9007199254740993", "9007199254740993.0", "9.007199254740993E+15", "1e400", "-1e400"])("keeps unsafe sibling number %s byte-identical while repairing count", number => {
    const raw = `{"count":1.0,"payload":{"values":[${number}]}}`;
    expect(coerceIntegerToolArguments(raw, schema)).toBe(`{"count":1,"payload":{"values":[${number}]}}`);
  });
  test("string repair cannot alter an unrelated large identifier", () => {
    const raw = '{"label":7,"identifier":9007199254740993}';
    expect(coerceIntegerToolArguments(raw, schema)).toBe('{"label":"7","identifier":9007199254740993}');
  });
  test("sees an unsafe value that a later duplicate key hides from JSON.parse", () => {
    const raw = '{"count":1.0,"id":9007199254740993,"id":1}';
    expect(coerceIntegerToolArguments(raw, schema)).toBe('{"count":1,"id":9007199254740993,"id":1}');
  });
  test("repairs a Codex-native number field beside an unsafe identifier", () => {
    const parameters = { type: "object", properties: { timeout_ms: { type: "number" } } };
    expect(coerceIntegerToolArguments('{"timeout_ms":120000.0,"id":9007199254740993}', parameters))
      .toBe('{"timeout_ms":120000,"id":9007199254740993}');
  });
  test.each(["integer", "number", "string"])("does not coerce unsafe tokens in %s fields or nested arrays", type => {
    const parameters = { type: "object", properties: {
      count: { type: "integer" }, values: { type: "array", items: { type: "array", items: { type } } },
    } };
    const raw = '{"count":2.0,"values":[[9007199254740993,-9007199254740993.0],[1e400,-1E+400]]}';
    expect(coerceIntegerToolArguments(raw, parameters))
      .toBe('{"count":2,"values":[[9007199254740993,-9007199254740993.0],[1e400,-1E+400]]}');
  });
  test("repairs nested safe array items while preserving every unsafe token", () => {
    const parameters = { type: "object", properties: { values: { type: "array", items: { type: "array", items: { type: "integer" } } } } };
    expect(coerceIntegerToolArguments('{"values":[[1.0,9007199254740993],[1E400,2.0]]}', parameters))
      .toBe('{"values":[[1,9007199254740993],[1E400,2]]}');
  });
  test("keeps duplicate unsafe tokens and repairs the effective duplicate property", () => {
    const raw = '{"count":9007199254740993,"count":2.0,"id":1E400,"id":-9007199254740993.0}';
    expect(coerceIntegerToolArguments(raw, schema))
      .toBe('{"count":9007199254740993,"count":2,"id":1E400,"id":-9007199254740993.0}');
  });
  test("cannot confuse escaped placeholder-like strings or keys with number tokens", () => {
    const raw = '{"count":1.0,"label":"\\u0000ocx-number:0","\\u0000ocx-number::0":"kept","id":1E400}';
    expect(coerceIntegerToolArguments(raw, schema))
      .toBe('{"count":1,"label":"\\u0000ocx-number:0","\\u0000ocx-number::0":"kept","id":1E400}');
  });
  test("leaves unsafe-only payloads and malformed input byte-identical", () => {
    for (const raw of [' {"count":9007199254740993,"id":1e400} ', '{"count":1.0,"id":1e400,}']) {
      expect(coerceIntegerToolArguments(raw, schema)).toBe(raw);
    }
  });
  test("ignores digits and escaped quotes inside strings", () => {
    expect(coerceIntegerToolArguments('{"count":1.0,"note":"say \\"9007199254740993\\" 1e400"}', schema))
      .toBe('{"count":1,"note":"say \\"9007199254740993\\" 1e400"}');
  });
  test("still repairs safe values, including the safe integer boundary", () => {
    expect(coerceIntegerToolArguments('{"count":1.0,"label":7,"value":9007199254740991}', schema))
      .toBe('{"count":1,"label":"7","value":9007199254740991}');
  });
  test("numeric-looking strings do not disable a safe repair", () => {
    expect(coerceIntegerToolArguments('{"count":1.0,"value":"9007199254740993"}', schema))
      .toBe('{"count":1,"value":"9007199254740993"}');
  });
  test("keeps unrepaired non-integral decimals in their original text", () => {
    expect(coerceIntegerToolArguments('{"count":1.0,"amount":0.12345678901234567890,"ratio":1.50,"big":1E2}', schema))
      .toBe('{"count":1,"amount":0.12345678901234567890,"ratio":1.50,"big":100}');
  });
  test.each([false, true])("bridge preserves unsafe tokens and repairs siblings (stream=%s)", async stream => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "wait" },
      { type: "tool_call_delta", arguments: '{"timeout_ms":120000.0,"id":9007199254740993,"overflow":1E400}' },
      { type: "tool_call_end", id: "call_1" }, { type: "done" },
    ];
    const options = { toolParameterSchemas: new Map([["wait", {
      type: "object", properties: { timeout_ms: { type: "number" } },
    }]]) };
    const expected = '{"timeout_ms":120000,"id":9007199254740993,"overflow":1E400}';
    if (stream) {
      async function* replay() { yield* events; }
      const body = await new Response(bridgeToResponsesSSE(replay(), "fixture", undefined, undefined, undefined, undefined, 2_000, options)).text();
      const frames = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      expect(frames.find(frame => frame.type === "response.function_call_arguments.done")?.arguments).toBe(expected);
      expect(frames.find(frame => frame.type === "response.output_item.done")?.item.arguments).toBe(expected);
    } else {
      const body = buildResponseJSON(events, "fixture", options);
      expect((body.output as Array<{ arguments?: string }>).find(item => item.arguments)?.arguments).toBe(expected);
    }
  });
});
