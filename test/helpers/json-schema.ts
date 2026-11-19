import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "schema", "releaseray.schema.json"), "utf8")
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

/**
 * Validates a config object against the committed JSON Schema.
 *
 * @param config - Parsed config
 * @returns Error messages; empty when valid
 */
export function jsonSchemaErrors(config: unknown): string[] {
  if (validate(config)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? ""}`);
}
