# Model providers

tnb connects directly to model endpoints. Provider identity and wire protocol
are separate: a provider can have any name while selecting one of the supported
API protocols.

## Built-in providers

`anthropic` uses the Anthropic Messages API and reads `ANTHROPIC_API_KEY` plus
the optional `ANTHROPIC_BASE_URL`. `openai` uses OpenAI Chat Completions and
reads `OPENAI_API_KEY` plus the optional `OPENAI_BASE_URL`.

Select them with `--provider`, and select a model with `--model`:

```bash
tnb -p "Inspect this project" --provider openai --model gpt-4o
```

`TNB_PROVIDER` and `TNB_MODEL` provide the corresponding environment
defaults. Command-line values take precedence.

List every configured provider/model without starting an Agent turn:

```bash
tnb models
tnb models --json
```

The first model under each provider is marked as its default. `--list-models`
is accepted as a command-line alias, and `--output-format json` is equivalent
to `--json`.

## Custom providers

Create `~/.tnb/models.json` (or `$TNB_HOME/models.json`):

```json
{
  "providers": {
    "deepseek": {
      "name": "DeepSeek",
      "api": "openai-completions",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "$DEEPSEEK_API_KEY",
      "headers": {
        "X-Client": "tnb"
      },
      "compat": {
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "deepseek-chat",
          "name": "DeepSeek Chat",
          "contextWindow": 64000,
          "maxTokens": 8192,
          "reasoning": false,
          "supportsVision": false,
          "supportsPdf": false
        }
      ]
    }
  }
}
```

Then run:

```bash
export DEEPSEEK_API_KEY="..."
tnb -p "Review the current changes" --provider deepseek
```

Validate a provider before starting a real Agent session:

```bash
# Confirms authentication, endpoint routing, SSE parsing, and text streaming.
tnb provider test deepseek --model deepseek-chat

# Also requires one streamed function call with valid JSON arguments.
tnb provider test deepseek --model deepseek-chat --tools --json
```

The diagnostic uses the same configured transport, headers, compatibility
profile, retry behavior, and model ID as normal Agent requests. It never prints
API keys or authorization headers. The text probe asks for a minimal `OK`
response; `--tools` exposes one inert diagnostic schema and verifies the model
returns the required tool name and `{ "value": "ok" }` arguments without
executing anything.

Run the maintained real-provider smoke matrix with the built-in compatibility
profiles:

```bash
bun run provider:smoke
```

The matrix currently covers `glm`, `qwen`, `deepseek`, and `openrouter`. Each
provider runs the same two probes as `tnb provider test`: one text-streaming
probe and one required tool-call probe. Missing credentials are reported as
skips instead of hard failures. Both probes also require positive provider-
reported input and output token usage, so a compatibility adapter that silently
drops prompt-token accounting fails the matrix.

Default environment variables:

| Provider | Required credential | Optional overrides |
| --- | --- | --- |
| `glm` | `ZAI_API_KEY` or `GLM_API_KEY` | `GLM_BASE_URL`, `GLM_MODEL`, `GLM_REASONING` |
| `qwen` | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` | `QWEN_BASE_URL`, `QWEN_MODEL`, `QWEN_REASONING` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_REASONING` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `OPENROUTER_REASONING` |

Run a subset by passing provider ids:

```bash
bun run provider:smoke deepseek openrouter
```

Custom providers already defined in `~/.tnb/models.json` can be probed by id,
without copying their credentials into a temporary catalog:

```bash
bun run provider:smoke yuanjing
bun run provider:smoke --configured
```

`--configured` tests every provider explicitly present in `models.json`. The
summary contains provider/model identifiers and diagnostics, but never emits
configured API keys or authorization headers.

The first configured model is the provider default. A custom provider rejects
an unknown `--model` value so a misspelling cannot silently use the wrong model.
The configured context and output limits drive automatic context compaction.
Set `supportsVision` when the model accepts image content and `supportsPdf`
when its selected API accepts PDF/file content. Both default to `false` for a
custom model. A vision model without native PDF support can still read an
explicit PDF page range through Poppler image extraction. Built-in Anthropic
and OpenAI models enable both capabilities.

The same provider catalog can supply the optional image-generation tool. See
[images.md](images.md) for provider selection, model overrides, and output
behavior.

## Usage, cost, and prompt caching

Every completed turn records provider-reported token usage in the session
JSONL. Interactive mode shows cumulative input/output tokens and estimated cost
in the status line. JSON and stream-JSON terminal results include `usage`,
`total_usage`, and `total_cost_usd`; streaming providers also emit a canonical
`usage` model event when the wire protocol reports it.

Model prices are configured in USD per million tokens. Cache reads and writes
are tracked separately so an Anthropic-compatible provider can use its actual
cache rates:

```json
{
  "providers": {
    "company-anthropic": {
      "api": "anthropic-messages",
      "baseUrl": "https://gateway.example/anthropic",
      "apiKey": "$COMPANY_API_KEY",
      "promptCaching": "1h",
      "models": [
        {
          "id": "company-coder",
          "contextWindow": 200000,
          "maxTokens": 32000,
          "pricing": {
            "input": 3,
            "output": 15,
            "cacheRead": 0.3,
            "cacheWrite": 3.75
          }
        }
      ]
    }
  }
}
```

`promptCaching` accepts `"5m"`, `"1h"`, or `false` and applies to the
Anthropic Messages protocol. The built-in Anthropic provider enables the
five-minute ephemeral policy. OpenAI-compatible endpoints use their automatic
prefix caching and report cached input through their usage fields; set
`compat.supportsUsageInStreaming` when a Chat Completions endpoint accepts
`stream_options.include_usage`.

Cost is an estimate based on the configured rates. Models without `pricing`
still report token counts and use a zero estimated cost rather than guessing a
vendor price. Override built-in model pricing in `modelOverrides` when a vendor
changes rates or a gateway applies different billing.

Supported `api` values are:

- `anthropic-messages` for Anthropic-compatible `/v1/messages` endpoints;
- `openai-completions` for OpenAI-compatible `/chat/completions` endpoints;
- `openai-responses` for OpenAI-compatible `/responses` endpoints.

`baseUrl` must be an HTTP(S) URL and should identify the API root. tnb
normalizes a trailing slash before appending the protocol route. A local server
may omit `apiKey`; authentication can also be supplied entirely through custom
headers.

For OpenAI Responses, use a separate provider or override the built-in `openai`
protocol:

```json
{
  "providers": {
    "openai-responses": {
      "api": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "$OPENAI_API_KEY",
      "models": [
        {
          "id": "gpt-5",
          "contextWindow": 400000,
          "maxTokens": 128000,
          "reasoning": true,
          "supportsVision": true,
          "supportsPdf": true,
          "compat": {
            "supportsDeveloperRole": true
          }
        }
      ]
    }
  }
}
```

The Responses adapter uses stateless `store: false` requests. Canonical user,
assistant, reasoning, tool-call, and tool-result history is converted to
Responses input items. Reasoning summaries and their encrypted provider item
are stored together in JSONL and replayed before the matching tool call, so a
stateless reasoning model can continue after receiving a tool result. Terminal
response output may replace an earlier incomplete signature when a compatible
endpoint supplies encrypted content only at completion. Streamed output text
and function calls are converted back to the same events consumed by the Agent
loop. `incomplete_details.reason =
max_output_tokens` maps to tnb's output-limit continuation path.

## Override a built-in provider

An existing provider can be redirected without repeating its API, credentials,
or model list. This is useful for an OpenAI or Anthropic proxy:

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://gateway.example/openai/v1",
      "headers": {
        "X-Gateway-Token": "$GATEWAY_TOKEN"
      },
      "modelOverrides": {
        "gpt-4o": {
          "contextWindow": 200000,
          "maxTokens": 32000,
          "headers": {
            "X-Model-Route": "fast"
          },
          "compat": {
            "maxTokensField": "max_tokens"
          }
        }
      }
    }
  }
}
```

Provider headers are inherited by every model. Model headers are applied last,
so a model can select a route or override a provider-wide header. Supplying a
`models` array replaces the built-in list; `modelOverrides` modifies named
models while preserving all unspecified fields. An unknown override target is
reported as a configuration error.

## Credentials and headers

`apiKey` and header values support `$NAME` and `${NAME}` environment expansion.
Use `$$` for a literal dollar sign. Missing referenced variables are reported
before any model request. Literal values are accepted, but environment references
avoid storing credentials in the configuration file.

Custom headers are applied after generated authentication and protocol headers,
so an explicit `Authorization` or `x-api-key` value can target a gateway with a
different authentication scheme.

## OpenAI compatibility

Provider-level `compat` values are inherited by every model; model-level values
override them. Supported fields are:

| Field | Effect |
| --- | --- |
| `supportsDeveloperRole` | Uses `developer` instead of `system` for the system prompt of reasoning models. |
| `supportsReasoningEffort` | Sends the selected reasoning effort in the provider-specific request format. |
| `maxTokensField` | Sends either `max_tokens` or `max_completion_tokens`. |
| `supportsUsageInStreaming` | Adds `stream_options.include_usage` when true. |
| `requiresToolResultName` | Restores the original tool name on replayed tool-result messages. |
| `requiresAssistantAfterToolResult` | Inserts an assistant bridge before a user message that follows tool results. |
| `requiresReasoningContentOnAssistantMessages` | Adds an empty `reasoning_content` field when replaying assistant history. |
| `thinkingFormat` | Selects `openai`, `deepseek`, `qwen`, or `openrouter` reasoning request fields. |
| `profile` | Applies a maintained `generic`, `glm`, `qwen`, `deepseek`, or `openrouter` compatibility preset before explicit overrides. |
| `anthropicRequiredToolChoice` | Uses `auto` instead of Anthropic's `any` when a compatible gateway rejects `tool_choice: {"type":"any"}`. |

Profiles are shorthand for tested protocol behavior and remain overridable per
provider or model. For example:

```json
{
  "providers": {
    "yuanjing": {
      "api": "anthropic-messages",
      "baseUrl": "https://maas-api.example/openapi/compatible-mode",
      "apiKey": "$YUANJING_API_KEY",
      "compat": { "anthropicRequiredToolChoice": "auto" },
      "models": [{ "id": "glm-5", "contextWindow": 200000, "maxTokens": 32000 }]
    },
    "deepseek": {
      "api": "openai-completions",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "$DEEPSEEK_API_KEY",
      "compat": { "profile": "deepseek" },
      "models": [{ "id": "deepseek-reasoner", "reasoning": true }]
    }
  }
}
```

The DeepSeek profile preserves streamed `reasoning_content` as canonical
thinking and replays it on assistant tool-call messages, as required by the
provider for subsequent tool rounds. The OpenRouter profile also accepts
`reasoning` and `reasoning_details` stream variants.

Select reasoning effort per run with `--thinking` or `TNB_THINKING`:

```bash
tnb -p "Investigate the failure" \
  --provider deepseek \
  --thinking high
```

Accepted levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
The model must declare `reasoning: true`. `openai` sends `reasoning_effort`,
`deepseek` sends `thinking.type` and optionally `reasoning_effort`, `qwen`
sends `enable_thinking`, and `openrouter` sends `reasoning.effort`.

A model may set `samplingParams` for provider-specific generation options:

```json
{
  "id": "local-coder",
  "contextWindow": 32768,
  "maxTokens": 4096,
  "samplingParams": {
    "temperature": 0.2,
    "top_p": 0.9
  }
}
```

Protocol-owned fields such as `model`, `stream`, `messages`, `tools`, and the
configured output-token field take precedence over `samplingParams`.

The same fields can be updated without editing JSON. Repeat `--header` and
`--sampling` for multiple values; sampling values are parsed as JSON:

```bash
tnb provider set deepseek \
  --header X-Route=fast \
  --reasoning-effort \
  --thinking-format deepseek

tnb provider model set deepseek deepseek-reasoner \
  --sampling temperature=0.2 \
  --sampling top_p=0.9 \
  --header X-Model-Route=reasoning
```

OpenAI-compatible tool calls may split their id, function name, and arguments
across separate stream deltas. tnb buffers the identity fields and restores
the canonical tool event order before handing the call to the Agent loop.

## Current boundary

Custom providers currently reuse one of the three supported wire protocols;
this configuration is not a plugin API for an entirely new protocol. Responses
reasoning items are persisted because that protocol supplies a replayable item.
Chat Completions reasoning text remains non-portable and is not copied into
Anthropic or Chat Completions history.
