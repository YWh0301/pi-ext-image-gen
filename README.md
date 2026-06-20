# pi-image-gen

Image generation extension for [Pi](https://github.com/earendil-works/pi). Currently adapted for **Alibaba Cloud Bailian (阿里云百炼)** only.

## Features

- Generate images from text prompts via `generate_image` tool (LLM-callable)
- `/imagine <prompt>` command for direct image generation
- `/image-gen` command for config and status
- `/image-save` command for re-saving generated images
- Inline image rendering in Pi TUI
- Save to disk with collision-avoidance naming
- Re-save via handle (`save_image` tool or `/image-save <handle> <path>`)
- Name conflict handling: informs agent without failing generation
- Async task fallback for API keys that don't support synchronous calls

## Install

```bash
pi install /path/to/pi-image-gen.ts
# or copy to ~/.pi/agent/extensions/ then /reload
```

## Configure

```bash
/image-gen key aliyun sk-xxx        # set API key
/image-gen model wan2.7-image-pro   # set default model (tab-complete)
/image-gen                          # show status
```

Or edit `~/.pi/agent/image-gen.json`:

```json
{
  "apiKeys": {
    "aliyun": "sk-xxx"
  },
  "defaultModel": "wan2.7-image-pro"
}
```

Environment variables also work: `DASHSCOPE_API_KEY`, etc.

## Usage

**Via agent**: just ask "generate an image of a cat"

**Via command**:
```bash
/imagine a cute cat in watercolor style
/imagine cyberpunk city --save project
/imagine mountain landscape --save output.png
```

**Save modes** (tool param `save`):
| value | behavior |
|-------|----------|
| `none` | inline only (default) |
| `project` | auto-name in project root |
| `output.png` | save to specific path |
| (path) | save to specific path like `output.png` |

**Re-save after generation**: use the handle from `generate_image` result:
```bash
/image-save <handle> <path>
/image-save list                    # list cached images
```

## Known Issues

- pi Issue #2874: Tab-completing a subcommand (`model`) doesn't automatically trigger next-level argument completions. Workaround: type the first letter of the desired model name after the space.
- Only Aliyun Bailian (阿里云百炼) has been tested with real API keys. Other providers (SiliconFlow, Tencent, OpenAI) have provider definitions but are untested.

## Models (tested)

| Provider | Model | Status |
|----------|-------|--------|
| aliyun | wan2.7-image-pro | ✅ working |
| aliyun | qwen-image-2.0-pro | ✅ working |
| aliyun | qwen-image-2.0-pro-2026-04-22 | ✅ working |
| aliyun | z-image-turbo | ✅ working |
| siliconflow | black-forest-labs/FLUX.1-dev | ⬜ untested |
| tencent | hunyuan-image | ⬜ untested |
| openai | dall-e-3 | ⬜ untested |
