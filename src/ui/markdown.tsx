import React, { memo, useMemo } from "react";
import { highlight, supportsLanguage } from "cli-highlight";
import { Box, Text } from "./ink/index";
import { marked, type Token, type Tokens } from "marked";

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
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      return <Text bold color="magenta">{inlineTokens(heading.tokens)}</Text>;
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return <Text wrap="wrap">{inlineTokens(paragraph.tokens)}</Text>;
    }
    case "text": {
      const text = token as Tokens.Text;
      return <Text wrap="wrap">{inlineTokens(text.tokens ?? [text])}</Text>;
    }
    case "code": {
      const code = token as Tokens.Code;
      const language = code.lang?.split(/\s+/)[0];
      const highlighted = highlight(code.text, {
        ...(language && supportsLanguage(language) ? { language } : {}),
        ignoreIllegals: true,
      });
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
              <Text color="magenta">{list.ordered ? `${Number(list.start) + index}.` : "•"} </Text>
              <Box flexDirection="column" flexGrow={1}>
                {item.tokens.map((child, childIndex) => <MarkdownBlock key={childIndex} token={child} />)}
              </Box>
            </Box>
          ))}
        </Box>
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      const rows = [table.header, ...table.rows];
      return (
        <Box flexDirection="column" borderStyle="single" borderColor="gray">
          {rows.map((row, rowIndex) => (
            <Text key={rowIndex} bold={rowIndex === 0}>
              {row.map((cell) => cell.text.trim()).join(" │ ")}
            </Text>
          ))}
        </Box>
      );
    }
    case "hr":
      return <Text dimColor>{"─".repeat(40)}</Text>;
    default:
      return <Text>{token.raw.trim()}</Text>;
  }
}

function inlineTokens(tokens: Token[]): React.ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "strong": {
        const strong = token as Tokens.Strong;
        return <Text key={index} bold>{inlineTokens(strong.tokens)}</Text>;
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return <Text key={index} italic>{inlineTokens(emphasis.tokens)}</Text>;
      }
      case "del": {
        const deleted = token as Tokens.Del;
        return <Text key={index} strikethrough>{inlineTokens(deleted.tokens)}</Text>;
      }
      case "codespan":
        return <Text key={index} color="cyan">{(token as Tokens.Codespan).text}</Text>;
      case "link": {
        const link = token as Tokens.Link;
        return <Text key={index} color="cyan" underline>{inlineTokens(link.tokens)} ({link.href})</Text>;
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
