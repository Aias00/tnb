import { defineTool, type AgentTool } from "../core/tool";

export function createStructuredOutputTool(
  schema: Record<string, unknown>,
  onOutput: (value: unknown) => void,
): AgentTool {
  assertToolSchema(schema);
  return defineTool({
    name: "structured_output",
    description: "Return the final response in the exact structured format requested by the caller. Call this tool exactly once when the task is complete.",
    inputSchema: schema,
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validate(input) {
      validateValue(input, schema, "$", schema);
      return structuredClone(input);
    },
    async execute(input) {
      onOutput(structuredClone(input));
      return "Structured output accepted.";
    },
  });
}

export function parseStructuredOutputSchema(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("--json-schema must be valid JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("--json-schema must be a JSON object");
  assertToolSchema(parsed);
  return parsed;
}

function assertToolSchema(schema: Record<string, unknown>): void {
  if (schema.type !== "object") {
    throw new Error("--json-schema root type must be object for provider tool calling");
  }
  validateSchemaShape(schema, "$", schema);
}

function validateSchemaShape(
  schema: Record<string, unknown>,
  path: string,
  root: Record<string, unknown>,
): void {
  if (schema.$ref !== undefined) resolveReference(schema.$ref, root, path);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)))) {
      throw new Error(`${path}.type contains an unsupported JSON Schema type`);
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))) {
    throw new Error(`${path}.required must be an array of property names`);
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) throw new Error(`${path}.properties must be an object`);
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!isRecord(child)) throw new Error(`${path}.properties.${name} must be a schema object`);
      validateSchemaShape(child, `${path}.properties.${name}`, root);
    }
  }
  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) throw new Error(`${path}.items must be a schema object`);
    validateSchemaShape(schema.items, `${path}.items`, root);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].some((item) => !isRecord(item))) {
      throw new Error(`${path}.${keyword} must be an array of schema objects`);
    }
    schema[keyword].forEach((item, index) => validateSchemaShape(item as Record<string, unknown>, `${path}.${keyword}[${index}]`, root));
  }
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  root: Record<string, unknown>,
): void {
  const resolved = schema.$ref === undefined ? schema : resolveReference(schema.$ref, root, path);
  if (resolved.const !== undefined && !deepEqual(value, resolved.const)) {
    throw new Error(`${path} must equal the schema const value`);
  }
  if (Array.isArray(resolved.enum) && !resolved.enum.some((candidate) => deepEqual(value, candidate))) {
    throw new Error(`${path} must match one of the allowed enum values`);
  }
  if (Array.isArray(resolved.allOf)) {
    for (const child of resolved.allOf) validateValue(value, child as Record<string, unknown>, path, root);
  }
  if (Array.isArray(resolved.anyOf) && !matchesExactly(value, resolved.anyOf, root, false)) {
    throw new Error(`${path} does not match any allowed schema`);
  }
  if (Array.isArray(resolved.oneOf) && !matchesExactly(value, resolved.oneOf, root, true)) {
    throw new Error(`${path} must match exactly one allowed schema`);
  }
  const types = resolved.type === undefined
    ? []
    : (Array.isArray(resolved.type) ? resolved.type : [resolved.type]).map(String);
  if (types.length && !types.some((type) => matchesType(value, type))) {
    throw new Error(`${path} must be ${types.join(" or ")}`);
  }
  if (isRecord(value)) {
    const properties = isRecord(resolved.properties) ? resolved.properties : {};
    for (const required of Array.isArray(resolved.required) ? resolved.required : []) {
      if (!(String(required) in value)) throw new Error(`${path}.${String(required)} is required`);
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (isRecord(childSchema)) validateValue(child, childSchema, `${path}.${name}`, root);
      else if (resolved.additionalProperties === false) throw new Error(`${path}.${name} is not allowed`);
      else if (isRecord(resolved.additionalProperties)) validateValue(child, resolved.additionalProperties, `${path}.${name}`, root);
    }
  }
  if (Array.isArray(value) && isRecord(resolved.items)) {
    value.forEach((item, index) => validateValue(item, resolved.items as Record<string, unknown>, `${path}[${index}]`, root));
  }
  if (typeof value === "string") {
    if (typeof resolved.minLength === "number" && value.length < resolved.minLength) throw new Error(`${path} is shorter than minLength`);
    if (typeof resolved.maxLength === "number" && value.length > resolved.maxLength) throw new Error(`${path} is longer than maxLength`);
    if (typeof resolved.pattern === "string" && !new RegExp(resolved.pattern, "u").test(value)) throw new Error(`${path} does not match pattern`);
  }
  if (typeof value === "number") {
    if (typeof resolved.minimum === "number" && value < resolved.minimum) throw new Error(`${path} is below minimum`);
    if (typeof resolved.maximum === "number" && value > resolved.maximum) throw new Error(`${path} is above maximum`);
  }
}

function matchesExactly(value: unknown, schemas: unknown[], root: Record<string, unknown>, exactlyOne: boolean): boolean {
  let matches = 0;
  for (const schema of schemas) {
    try {
      validateValue(value, schema as Record<string, unknown>, "$", root);
      matches += 1;
    } catch {}
  }
  return exactlyOne ? matches === 1 : matches > 0;
}

function resolveReference(reference: unknown, root: Record<string, unknown>, path: string): Record<string, unknown> {
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    throw new Error(`${path} uses an unsupported non-local $ref`);
  }
  let current: unknown = root;
  for (const segment of reference.slice(2).split("/")) {
    if (!isRecord(current)) throw new Error(`${path} contains an unresolved $ref: ${reference}`);
    current = current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  if (!isRecord(current)) throw new Error(`${path} contains an unresolved $ref: ${reference}`);
  return current;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
