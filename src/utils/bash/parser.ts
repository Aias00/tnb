import {
  getParserModule,
  type TsNode,
} from "./bash-parser";

export type Node = TsNode;

const MAX_COMMAND_LENGTH = 10_000;

export const PARSE_ABORTED = Symbol("parse-aborted");

export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  return parseCommandRawSync(command);
}

export function parseCommandRawSync(command: string): Node | null | typeof PARSE_ABORTED {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;
  try {
    return getParserModule()?.parse(command) ?? PARSE_ABORTED;
  } catch {
    return PARSE_ABORTED;
  }
}
