import React, { memo, useMemo } from "react";
import { highlight, supportsLanguage } from "cli-highlight";
import { Box, Text } from "./ink/index";
import { marked, type Token, type Tokens } from "marked";

import { stringWidth } from "./ink/stringWidth";
import { useAccent, type AccentColor } from "./theme";

type MarkdownProps = { children: string; streaming?: boolean };

export const Markdown = memo(function Markdown({ children }: MarkdownProps) {
  const tokens = useMemo(() => marked.lexer(children, { gfm: true }), [children]);
  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <MarkdownBlock key={`${token.type}-${index}`} token={token} />
      ))}
    </Box>
  );
});

function MarkdownBlock({ token }: { token: Token }): React.ReactNode {
  const accent = useAccent();
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      return <Text bold color={accent}>{inlineTokens(heading.tokens, accent)}</Text>;
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return <Text wrap="wrap">{inlineTokens(paragraph.tokens, accent)}</Text>;
    }
    case "text": {
      const text = token as Tokens.Text;
      return <Text wrap="wrap">{inlineTokens(text.tokens ?? [text], accent)}</Text>;
    }
    case "code": {
      const code = token as Tokens.Code;
      const language = code.lang?.split(/\s+/)[0];
      const highlighted = language && supportsLanguage(language)
        ? highlight(code.text, { language, ignoreIllegals: true })
        : code.text;
      return (
        <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
          {code.lang ? <Text dimColor>{code.lang}</Text> : null}
          <Text>{highlighted}</Text>
        </Box>
      );
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      return (
        <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
          <Box flexDirection="column">{quote.tokens.map((child, index) => <MarkdownBlock key={index} token={child} />)}</Box>
        </Box>
      );
    }
    case "list": {
      const list = token as Tokens.List;
      return (
        <Box flexDirection="column">
          {list.items.map((item, index) => (
            <Box key={index} paddingLeft={1}>
              <Text color={accent}>{list.ordered ? `${Number(list.start) + index}.` : "•"} </Text>
              <Box flexDirection="column" flexGrow={1}>
                {item.tokens.map((child, childIndex) => <MarkdownBlock key={childIndex} token={child} />)}
              </Box>
            </Box>
          ))}
        </Box>
      );
    }
    case "table":
      return <MarkdownTable table={token as Tokens.Table} accent={accent} />;
    case "hr":
      return <Text dimColor>{"─".repeat(40)}</Text>;
    default:
      return <Text>{token.raw.trim()}</Text>;
  }
}

function inlineText(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.type === "link") { const link = token as Tokens.Link; return `${inlineText(link.tokens)} (${link.href})`; }
    if ("tokens" in token && Array.isArray(token.tokens)) return inlineText(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : token.type === "br" ? "\n" : token.raw;
  }).join("");
}

function MarkdownTable({ table, accent }: { table: Tokens.Table; accent: AccentColor }) {
  const rows = [table.header, ...table.rows];
  const widths = table.header.map((_, column) => Math.min(60, Math.max(1, ...rows.map(row => {
    const tokens = row[column]?.tokens ?? [];
    return Math.max(0, ...inlineText(tokens).split("\n").map(line => stringWidth(line)));
  }))));
  return <Box flexDirection="column" borderStyle="single" borderColor="gray" width="100%" flexShrink={0}>
    {rows.map((row, rowIndex) => <Box key={rowIndex} flexDirection="row" alignItems="stretch" flexShrink={0}
      borderStyle="single" borderColor="gray" borderTop={false} borderLeft={false} borderRight={false} borderBottom={rowIndex === 0}>
      {table.header.map((_, column) => <Box key={column} width={widths[column]! + 3} minWidth={Math.min(widths[column]! + 3, 11)} flexGrow={1} flexShrink={1} paddingX={1}
        borderStyle="single" borderColor="gray" borderTop={false} borderBottom={false} borderLeft={false} borderRight={column < table.header.length - 1}
        justifyContent={table.align[column] === "right" ? "flex-end" : table.align[column] === "center" ? "center" : "flex-start"}>
        <Text bold={rowIndex === 0} wrap="wrap">{inlineTokens(row[column]?.tokens ?? [], accent)}</Text>
      </Box>)}
    </Box>)}
  </Box>;
}

function inlineTokens(tokens: Token[], accent: AccentColor): React.ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "strong": {
        const strong = token as Tokens.Strong;
        return <Text key={index} bold>{inlineTokens(strong.tokens, accent)}</Text>;
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return <Text key={index} italic>{inlineTokens(emphasis.tokens, accent)}</Text>;
      }
      case "del": {
        const deleted = token as Tokens.Del;
        return <Text key={index} strikethrough>{inlineTokens(deleted.tokens, accent)}</Text>;
      }
      case "codespan":
        return <Text key={index} color={accent}>{(token as Tokens.Codespan).text}</Text>;
      case "link": {
        const link = token as Tokens.Link;
        return <Text key={index} color={accent} underline>{inlineTokens(link.tokens, accent)} ({link.href})</Text>;
      }
      case "br":
        return <Text key={index}>{"\n"}</Text>;
      case "escape":
      case "text": {
        const text = token as Tokens.Text | Tokens.Escape;
        return <Text key={index}>{text.text}</Text>;
      }
      default:
        return <Text key={index}>{token.raw}</Text>;
    }
  });
}
