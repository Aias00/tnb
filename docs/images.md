# Image search and generation

tnb exposes image capabilities as ordinary permission-controlled tools.
They use direct HTTP requests and do not add an image SDK dependency.

## Image search

Set `BRAVE_SEARCH_API_KEY` to enable both `web_search` and `image_search`:

```bash
export BRAVE_SEARCH_API_KEY="..."
```

`image_search` uses Brave's official image-search endpoint. It preserves the
provider default of 50 results when `count` is omitted, accepts the documented
1–200 range, and defaults to Brave's strict safe-search policy. Results include
the source page, original image URL, thumbnail, and dimensions when the API
provides them. Search results do not imply a license to reuse an image.

Use `BRAVE_IMAGE_SEARCH_BASE_URL` only when routing image search through a
compatible gateway. `BRAVE_SEARCH_BASE_URL` remains specific to web search.

## Image generation

When the selected model provider uses an OpenAI-compatible protocol,
`image_generate` reuses that provider's base URL, API key, and custom headers.
If the active provider is Anthropic, tnb uses the configured `openai`
provider when it has credentials. The default image model is `gpt-image-2`.

The tool calls `/v1/images/generations`, requests one base64-encoded image,
checks that the returned bytes match the requested PNG, WebP, or JPEG format,
and writes only inside the active workspace. The image is also returned to a
vision-capable conversation as a tool attachment for inspection.

The image provider is independently configurable:

```bash
export TNB_IMAGE_PROVIDER="company-openai"
export TNB_IMAGE_MODEL="company-image-v2"
```

`TNB_IMAGE_PROVIDER` names a provider from `models.json`; its protocol
must be `openai-completions` or `openai-responses`. These optional overrides
are also available for gateways that do not share the chat provider settings:

```bash
export TNB_IMAGE_BASE_URL="https://images.example/v1"
export TNB_IMAGE_API_KEY="..."
```

Image generation is a network operation with a workspace write and can incur
provider charges. It therefore follows the normal permission engine; plan mode
denies it, while explicit YOLO mode permits it under the same security gates as
other tools.

## Clipboard images

Press Ctrl+V in the Ink TUI to attach a PNG from the system clipboard. tnb
uses the platform clipboard command (`osascript`, `wl-paste`/`xclip`, or
PowerShell), validates the PNG signature, includes the image through the normal
attachment pipeline, and deletes the temporary file after the turn.

When the terminal advertises Kitty graphics, iTerm2, or WezTerm support, the
TUI also renders pasted and generated images inline. Other terminals receive no
image control sequence and continue to show the attachment or output path.
