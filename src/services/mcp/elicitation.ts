import type { PermissionChecker, ToolPolicy } from "../../core/permissions";
import type { AskUser, UserQuestion } from "../../tools/interaction";
import { McpRequestError } from "./client";

export type McpElicitationResult =
  | { action: "accept"; content?: Record<string, unknown> }
  | { action: "decline" | "cancel" };

export type McpElicitationHandler = (
  params: unknown,
  signal: AbortSignal,
) => Promise<McpElicitationResult>;

export type McpElicitationContext = {
  serverName: string;
  message: string;
  mode: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
};

type ParsedElicitation =
  | {
      mode: "form";
      message: string;
      requestedSchema: Record<string, unknown>;
      properties: Array<{ name: string; required: boolean; schema: FieldSchema }>;
    }
  | {
      mode: "url";
      message: string;
      url: string;
      host: string;
      elicitationId?: string;
    };

type Choice = { label: string; value: string };

type FieldSchema = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  defaultValue?: unknown;
  choices?: Choice[];
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  format?: "email" | "uri" | "date" | "date-time";
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export function createMcpElicitationHandler(options: {
  serverName: string;
  authorize: PermissionChecker;
  askUser?: AskUser;
  onRequest?(context: McpElicitationContext, signal: AbortSignal): Promise<McpElicitationResult | undefined>;
  onResult?(context: McpElicitationContext, result: McpElicitationResult, signal: AbortSignal): Promise<McpElicitationResult>;
}): McpElicitationHandler {
  return async (params, signal) => {
    const request = parseElicitation(params);
    const context: McpElicitationContext = {
      serverName: options.serverName,
      message: request.message,
      mode: request.mode,
      ...(request.mode === "url"
        ? { url: request.url, ...(request.elicitationId ? { elicitationId: request.elicitationId } : {}) }
        : { requestedSchema: request.requestedSchema }),
    };
    const finish = (result: McpElicitationResult) =>
      options.onResult ? options.onResult(context, result, signal) : Promise.resolve(result);
    const decision = await options.authorize(
      elicitationPolicy(options.serverName),
      request.mode === "url"
        ? {
            server: options.serverName,
            mode: request.mode,
            message: request.message,
            url: request.url,
            host: request.host,
          }
        : {
            server: options.serverName,
            mode: request.mode,
            message: request.message,
            fields: request.properties.map(({ name, required, schema }) => ({
              name,
              required,
              type: schema.type,
              title: schema.title,
              description: schema.description,
            })),
          },
      signal,
    );
    if (decision.behavior === "deny") return { action: "decline" };
    const hookResponse = await options.onRequest?.(context, signal);
    if (hookResponse) return finish(hookResponse);
    if (request.mode === "url") return finish({ action: "accept" });
    if (!options.askUser) return finish({ action: "cancel" });

    try {
      const content: Record<string, unknown> = {};
      for (const field of request.properties) {
        signal.throwIfAborted();
        if (!field.required) {
          const action = await options.askUser({
            header: "MCP input",
            question: `${request.message}\n\nProvide optional field “${field.schema.title ?? field.name}”?`,
            options: [
              { label: "Provide value", description: "Enter a value for this field." },
              { label: "Skip", description: "Leave this optional field unset." },
            ],
            multiSelect: false,
          }, signal);
          if (action === "Skip") continue;
        }
        content[field.name] = await askForField(
          options.askUser,
          request.message,
          field.name,
          field.schema,
          signal,
        );
      }
      return finish({ action: "accept", content });
    } catch (error) {
      if (signal.aborted || error instanceof DOMException && error.name === "AbortError") {
        return finish({ action: "cancel" });
      }
      return finish({ action: "cancel" });
    }
  };
}

async function askForField(
  askUser: AskUser,
  message: string,
  name: string,
  schema: FieldSchema,
  signal: AbortSignal,
): Promise<unknown> {
  const label = schema.title ?? name;
  const prompt = [message, schema.description, `Enter “${label}” (${schema.type}).`]
    .filter(Boolean)
    .join("\n\n");
  const options = schema.choices
    ? schema.choices.map(({ label: choiceLabel }) => ({
        label: choiceLabel,
        description: `Use ${choiceLabel}.`,
      }))
    : schema.type === "boolean"
      ? [
          { label: "true", description: "Enable this value." },
          { label: "false", description: "Disable this value." },
        ]
      : schema.defaultValue !== undefined
        ? [{ label: "Use default", description: `Use ${JSON.stringify(schema.defaultValue)}.` }]
        : [];
  const question: UserQuestion = {
    header: "MCP input",
    question: prompt,
    options,
    multiSelect: schema.type === "array",
  };
  while (true) {
    const answer = await askUser(question, signal);
    try {
      return parseFieldAnswer(answer, schema);
    } catch (error) {
      question.question = `${prompt}\n\n${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function parseFieldAnswer(answer: string, schema: FieldSchema): unknown {
  if (answer === "Use default" && schema.defaultValue !== undefined) {
    return structuredClone(schema.defaultValue);
  }
  if (schema.type === "boolean") {
    if (answer === "true") return true;
    if (answer === "false") return false;
    throw new Error("Choose true or false.");
  }
  if (schema.type === "number" || schema.type === "integer") {
    const value = Number(answer);
    if (!Number.isFinite(value) || schema.type === "integer" && !Number.isInteger(value)) {
      throw new Error(`Enter a valid ${schema.type}.`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`Value must be at least ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`Value must be at most ${schema.maximum}.`);
    }
    return value;
  }
  if (schema.type === "array") {
    const labels = answer.split(",").map((value) => value.trim()).filter(Boolean);
    const values = labels.map((label) => choiceValue(schema.choices ?? [], label));
    if (schema.minItems !== undefined && values.length < schema.minItems) {
      throw new Error(`Select at least ${schema.minItems} values.`);
    }
    if (schema.maxItems !== undefined && values.length > schema.maxItems) {
      throw new Error(`Select at most ${schema.maxItems} values.`);
    }
    return values;
  }
  const value = schema.choices ? choiceValue(schema.choices, answer) : answer;
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new Error(`Value must contain at least ${schema.minLength} characters.`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new Error(`Value must contain at most ${schema.maxLength} characters.`);
  }
  if (schema.pattern && !schema.pattern.test(value)) throw new Error("Value does not match the required pattern.");
  if (schema.format && !matchesFormat(value, schema.format)) {
    throw new Error(`Value must use the ${schema.format} format.`);
  }
  return value;
}

function parseElicitation(value: unknown): ParsedElicitation {
  const request = objectValue(value, "elicitation request");
  if (typeof request.message !== "string" || !request.message.trim()) {
    throw new McpRequestError(-32602, "Elicitation message is required");
  }
  const mode = request.mode ?? "form";
  if (mode === "url") {
    if (request.elicitationId !== undefined &&
      (typeof request.elicitationId !== "string" || !request.elicitationId)) {
      throw new McpRequestError(-32602, "URL elicitationId must be a non-empty string");
    }
    if (typeof request.url !== "string") throw new McpRequestError(-32602, "URL elicitation URL is required");
    let url: URL;
    try {
      url = new URL(request.url);
    } catch (error) {
      throw new McpRequestError(-32602, "URL elicitation URL is invalid");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new McpRequestError(-32602, "URL elicitation requires an HTTP(S) URL without credentials");
    }
    return {
      mode,
      message: request.message,
      url: url.href,
      host: url.host,
      ...(typeof request.elicitationId === "string" ? { elicitationId: request.elicitationId } : {}),
    };
  }
  if (mode !== "form") throw new McpRequestError(-32602, "Elicitation mode must be form or url");
  const schema = objectValue(request.requestedSchema, "elicitation requestedSchema");
  if (schema.type !== "object") {
    throw new McpRequestError(-32602, "Elicitation requestedSchema must describe an object");
  }
  const properties = objectValue(schema.properties ?? {}, "elicitation schema properties");
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
    throw new McpRequestError(-32602, "Elicitation schema required must be a string array");
  }
  const requiredNames = new Set(required as string[]);
  for (const name of requiredNames) {
    if (!(name in properties)) throw new McpRequestError(-32602, `Required elicitation field is missing: ${name}`);
  }
  return {
    mode,
    message: request.message,
    requestedSchema: schema,
    properties: Object.entries(properties).map(([name, field]) => {
      if (isSensitiveFieldName(name)) {
        throw new McpRequestError(-32602, `Sensitive field is not allowed in form elicitation: ${name}`);
      }
      return { name, required: requiredNames.has(name), schema: parseFieldSchema(field, name) };
    }),
  };
}

function parseFieldSchema(value: unknown, name: string): FieldSchema {
  const schema = objectValue(value, `elicitation field ${name}`);
  if (
    schema.type !== "string" && schema.type !== "number" && schema.type !== "integer" &&
    schema.type !== "boolean" && schema.type !== "array"
  ) {
    throw new McpRequestError(-32602, `Elicitation field ${name} has an unsupported type`);
  }
  const result: FieldSchema = {
    type: schema.type,
    ...(optionalString(schema.title, `${name}.title`) === undefined ? {} : { title: schema.title as string }),
    ...(optionalString(schema.description, `${name}.description`) === undefined
      ? {}
      : { description: schema.description as string }),
  };
  if (schema.type === "string") {
    const choices = parseChoices(schema, name);
    const minLength = optionalNonNegativeInteger(schema.minLength, `${name}.minLength`);
    const maxLength = optionalNonNegativeInteger(schema.maxLength, `${name}.maxLength`);
    if (choices !== undefined) result.choices = choices;
    if (minLength !== undefined) result.minLength = minLength;
    if (maxLength !== undefined) result.maxLength = maxLength;
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw new McpRequestError(-32602, `${name}.minLength cannot exceed maxLength`);
    }
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") throw new McpRequestError(-32602, `${name}.pattern must be a string`);
      try {
        result.pattern = new RegExp(schema.pattern);
      } catch (error) {
        throw new McpRequestError(-32602, `${name}.pattern is invalid`);
      }
    }
    if (schema.format !== undefined) {
      if (schema.format !== "email" && schema.format !== "uri" && schema.format !== "date" && schema.format !== "date-time") {
        throw new McpRequestError(-32602, `${name}.format is unsupported`);
      }
      result.format = schema.format;
    }
  } else if (schema.type === "number" || schema.type === "integer") {
    const minimum = optionalFiniteNumber(schema.minimum, `${name}.minimum`);
    const maximum = optionalFiniteNumber(schema.maximum, `${name}.maximum`);
    if (minimum !== undefined) result.minimum = minimum;
    if (maximum !== undefined) result.maximum = maximum;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new McpRequestError(-32602, `${name}.minimum cannot exceed maximum`);
    }
  } else if (schema.type === "array") {
    const items = objectValue(schema.items, `${name}.items`);
    const choices = parseChoices(items, `${name}.items`);
    if (!choices?.length) throw new McpRequestError(-32602, `${name}.items must declare enum choices`);
    result.choices = choices;
    const minItems = optionalNonNegativeInteger(schema.minItems, `${name}.minItems`);
    const maxItems = optionalNonNegativeInteger(schema.maxItems, `${name}.maxItems`);
    if (minItems !== undefined) result.minItems = minItems;
    if (maxItems !== undefined) result.maxItems = maxItems;
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      throw new McpRequestError(-32602, `${name}.minItems cannot exceed maxItems`);
    }
  }
  if (schema.default !== undefined) {
    result.defaultValue = validateDefault(schema.default, result, name);
  }
  return result;
}

function parseChoices(schema: Record<string, unknown>, name: string): Choice[] | undefined {
  let choices: Choice[];
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.some((value) => typeof value !== "string")) {
      throw new McpRequestError(-32602, `${name}.enum must contain strings`);
    }
    choices = (schema.enum as string[]).map((value) => ({ label: value, value }));
  } else {
    const variants = schema.oneOf ?? schema.anyOf;
    if (variants === undefined) return undefined;
    if (!Array.isArray(variants)) throw new McpRequestError(-32602, `${name} choices must be an array`);
    choices = variants.map((entry, index) => {
      const choice = objectValue(entry, `${name} choice ${index}`);
      if (typeof choice.const !== "string" || typeof choice.title !== "string") {
        throw new McpRequestError(-32602, `${name} choices require string const and title values`);
      }
      return { label: choice.title, value: choice.const };
    });
  }
  if (
    choices.length === 0 ||
    new Set(choices.map(({ label }) => label)).size !== choices.length ||
    new Set(choices.map(({ value }) => value)).size !== choices.length
  ) {
    throw new McpRequestError(-32602, `${name} choices must be non-empty and unique`);
  }
  return choices;
}

function validateDefault(value: unknown, schema: FieldSchema, name: string): unknown {
  const validShape =
    schema.type === "boolean" && typeof value === "boolean" ||
    schema.type === "number" && typeof value === "number" && Number.isFinite(value) ||
    schema.type === "integer" && typeof value === "number" && Number.isInteger(value) ||
    schema.type === "string" && typeof value === "string" ||
    schema.type === "array" && Array.isArray(value) && value.every((entry) => typeof entry === "string");
  if (!validShape) throw new McpRequestError(-32602, `Default value for ${name} does not match its type`);
  try {
    return parseFieldAnswer(Array.isArray(value) ? value.join(",") : String(value), schema);
  } catch (error) {
    throw new McpRequestError(
      -32602,
      `Default value for ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function choiceValue(choices: Choice[], label: string): string {
  const choice = choices.find((entry) => entry.label === label || entry.value === label);
  if (!choice) throw new Error("Choose one of the listed values.");
  return choice.value;
}

function matchesFormat(value: string, format: NonNullable<FieldSchema["format"]>): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === "uri") {
    try {
      void new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  return !Number.isNaN(Date.parse(value));
}

function elicitationPolicy(serverName: string): ToolPolicy {
  return {
    name: `mcp__${serverName}__elicitation`,
    risk: "network",
    isReadOnly: () => false,
    requiresApproval: () => true,
    permissionRuleContent: () => serverName,
  };
}

function isSensitiveFieldName(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
  return /(?:^|_)(?:password|passphrase|secret|client_secret|token|access_token|refresh_token|api_key|credential|credentials|private_key|card_number|credit_card|cvv|cvc)(?:_|$)/.test(normalized);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new McpRequestError(-32602, `${label} must be a string`);
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new McpRequestError(-32602, `${label} must be a non-negative integer`);
  }
  return value as number;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new McpRequestError(-32602, `${label} must be a finite number`);
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpRequestError(-32602, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
