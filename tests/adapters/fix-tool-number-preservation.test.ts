import { describe, expect, test } from "bun:test";
import { coerceIntegerToolArguments } from "../../src/lib/tool-argument-integers";
const schema = { type: "object", properties: { count: { type: "integer" }, label: { type: "string" } } };

describe("tool argument numeric preservation", () => {
  test.each(["9007199254740993", "-9007199254740993", "1e400", "-1e400"])("keeps unsafe sibling number %s byte-identical", number => {
    const raw = `{"count":1.0,"payload":{"values":[${number}]}}`;
    expect(coerceIntegerToolArguments(raw, schema)).toBe(raw);
  });
  test("string repair cannot alter an unrelated large identifier", () => {
    const raw = '{"label":7,"identifier":9007199254740993}';
    expect(coerceIntegerToolArguments(raw, schema)).toBe(raw);
  });
  test("sees an unsafe value that a later duplicate key hides from JSON.parse", () => {
    const raw = '{"count":1.0,"id":9007199254740993,"id":1}';
    expect(coerceIntegerToolArguments(raw, schema)).toBe(raw);
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
});
