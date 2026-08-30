import { describe, expect, it } from "vitest";

import { RUNNER_INVOCATION_RESULT_VALIDATOR } from "../../src/composition/runner-factory.js";

const validates = (schema: unknown, value: unknown) => RUNNER_INVOCATION_RESULT_VALIDATOR.validate(schema as never, value as never);

describe("Runner-fixed Invocation result validator", () => {
  it("accepts the closed object and composition keywords used by admitted Actions", () => {
    expect(validates({
      type: "object",
      properties: {
        status: { type: "string", enum: ["confirmed", "needs-user"] },
        count: { type: "integer", minimum: 0, maximum: 2 },
        labels: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", minLength: 1, maxLength: 8, pattern: "^[a-z]+$" } },
      },
      required: ["status", "count", "labels"],
      additionalProperties: false,
      allOf: [{ not: { properties: { status: { const: "needs-user" } }, required: ["status"] } }],
      anyOf: [{ properties: { count: { const: 0 } } }, { properties: { count: { const: 1 } } }],
      oneOf: [{ properties: { status: { const: "confirmed" } } }, { properties: { status: { const: "needs-user" } } }],
    }, { status: "confirmed", count: 1, labels: ["ok"] })).toBe(true);
    expect(validates({ const: { left: 1, right: 2 } }, { right: 2, left: 1 })).toBe(true);
  });

  it("fails closed for unsupported, malformed, extra, and constraint-breaking schemas/results", () => {
    expect(validates({ unknownKeyword: true }, {})).toBe(false);
    expect(validates({ type: [] }, {})).toBe(false);
    expect(validates({ type: "string", pattern: "[" }, "x")).toBe(false);
    expect(validates({ type: "string", minLength: "1" }, "x")).toBe(false);
    expect(validates({ type: "object", properties: { absent: { unsupported: true } } }, {})).toBe(false);
    expect(validates({ type: "object", required: ["missing"] }, {})).toBe(false);
    expect(validates({ type: "object", properties: {}, additionalProperties: false }, { extra: true })).toBe(false);
    expect(validates({ type: "array", items: { type: "integer" } }, [1, 1.5])).toBe(false);
    expect(validates({ type: "number", minimum: 2, maximum: 3 }, 1)).toBe(false);
    expect(validates({ type: "string", minLength: 2 }, "x")).toBe(false);
    expect(validates({ oneOf: [{ type: "number" }, { minimum: 0 }] }, 1)).toBe(false);
  });

  it("fails closed for every malformed recursive schema family and remaining bounded-value constraint", () => {
    const malformedSchemas = [
      { description: 1 },
      { type: ["string", "string"] },
      { type: "unsupported" },
      { enum: [] },
      { maxItems: -1 },
      { maximum: Number.POSITIVE_INFINITY },
      { pattern: 1 },
      { required: ["duplicate", "duplicate"] },
      { properties: [] },
      { items: { unknownKeyword: true } },
      { additionalProperties: { unknownKeyword: true } },
      { allOf: [{ unknownKeyword: true }] },
      { not: { unknownKeyword: true } },
    ];
    for (const schema of malformedSchemas) expect(validates(schema, {})).toBe(false);

    expect(validates({ type: "string", maxLength: 1 }, "too long")).toBe(false);
    expect(validates({ type: "string", pattern: "^ok$" }, "wrong")).toBe(false);
    expect(validates({ type: "number", maximum: 1 }, 2)).toBe(false);
    expect(validates({ type: "array", minItems: 2 }, [1])).toBe(false);
    expect(validates({ type: "array", maxItems: 1 }, [1, 2])).toBe(false);
    expect(validates({ type: "object", additionalProperties: { type: "integer" } }, { extra: "wrong" })).toBe(false);

    const hostileSchema = new Proxy({}, { ownKeys() { throw new Error("hostile schema"); } });
    expect(validates(hostileSchema, {})).toBe(false);
  });
});
