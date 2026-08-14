import ajv2020 from "ajv/dist/2020.js";
import type { Ajv2020 } from "ajv/dist/2020.js";

// ajv ships CJS: `module.exports` is the class itself and also carries a `default`
// property. Both shapes are handled here so nothing else has to know.
const Ctor = ((ajv2020 as unknown as { default?: unknown }).default ?? ajv2020) as new (
  opts?: Record<string, unknown>,
) => Ajv2020;

export function newValidator(): Ajv2020 {
  return new Ctor({ allErrors: true, strict: false, useDefaults: true });
}
