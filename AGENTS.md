# pi-image-gen — Agent Guide

## Overview

pi-image-gen is a [Pi](https://github.com/earendil-works/pi) extension that generates images from text prompts. It is a single-file TypeScript extension (`pi-image-gen.ts`) that registers:

- **Tools** (LLM-callable): `generate_image`, `save_image`
- **Commands** (user-invocable): `/imagine`, `/image-gen`, `/image-save`

Currently only **Alibaba Cloud Bailian (阿里云百炼)** has been tested with real API keys. Other providers (SiliconFlow, Tencent, OpenAI) have definitions in the code but are untested.

---

## File Structure

```
pi-image-gen/
  pi-image-gen.ts    — Single-file extension (all logic)
  AGENTS.md          — This file: agent onboarding
  README.md          — User-facing docs
  .gitignore         — Ignores *.png, .pi/, generated-images/
```

---

## pi Extension Architecture

### How Extensions Load

Pi auto-discovers extensions from `~/.pi/agent/extensions/*.ts` and project-local `.pi/extensions/*.ts`. They are loaded via [jiti](https://github.com/unjs/jiti) (TypeScript without compilation). The module must `export default function (pi: ExtensionAPI)`.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ ... });
  pi.registerCommand("name", { description: "...", handler: async (args, ctx) => { ... } });
}
```

### ExtensionAPI Methods Used

| Method | Purpose |
|--------|---------|
| `pi.registerTool({...})` | Register an LLM-callable tool |
| `pi.registerCommand(name, {...})` | Register a slash command |
| `pi.sendMessage({...})` | Inject a custom message into the session |

### Tool Registration (`registerTool`)

```typescript
pi.registerTool({
  name: "tool_name",              // snake_case, used by LLM
  label: "Tool Name",             // Display name
  description: "What it does",    // Shown to LLM to decide when to call
  promptSnippet: "One-liner",     // Appears in "Available tools" section
  promptGuidelines: ["..."],      // Behavioural instructions for LLM
  parameters: Type.Object({ ... }), // Schema using typebox
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // toolCallId: string
    // params: Record<string, unknown> (validated against parameters)
    // signal: AbortSignal (for cancellation)
    // onUpdate: (update) => void (stream progress to tool call box)
    // ctx: ExtensionContext (has cwd, ui, modelRegistry, etc.)
    return { content: [...], details: {} };
  },
});
```

**Critical**: To signal an error (red tool call box), `throw new Error(...)`. Returning error content in `return { content }` will NOT show red.

### Command Registration (`registerCommand`)

```typescript
pi.registerCommand("command-name", {
  description: "What it does",
  getArgumentCompletions: (prefix) => { ... }, // Optional tab completion
  handler: async (args: string, ctx) => { ... },
});
```

**Critical**: `args` is a **string**, not an array. Always split manually:
```typescript
const parts = (args || "").trim().split(/\s+/);
```

### Tab Completion Bug

Pi has a known bug (Issue #2874) where after Tab-completing a command, argument completions don't trigger. The user must type a character (not press Tab) to trigger second-level completions.

In `getArgumentCompletions`, the `prefix` parameter is the text after the command name. For multi-level completion, check for spaces:
```typescript
getArgumentCompletions: (prefix) => {
  const p = prefix || "";
  const spaceAt = p.indexOf(" ");
  if (spaceAt === -1) {
    // First level: no space yet
    return [{ value: "model", label: "model <name>" }];
  }
  // Second level: space exists
  const first = p.slice(0, spaceAt);
  const rest = p.slice(spaceAt + 1);
  if (first === "model") {
    return models.filter(m => m.startsWith(rest))
      .map(m => ({ value: `model ${m}`, label: m }));
  }
}
```

**Important**: The completion `value` must include the subcommand prefix (e.g. `"model xxx"` not just `"xxx"`) because the autocomplete system replaces the ENTIRE prefix, not just the current word.

### Image Rendering in TUI

For inline image display in Pi TUI, tool results must return images as **base64 inline data**, not URLs:

```typescript
// ✅ Works in TUI
{ type: "image", data: base64String, mimeType: "image/png" }

// ❌ May not render
{ type: "image", url: "https://..." }
```

Reference: `antigravity-image-gen.ts` in pi-mono examples.

---

## Extension Design

### Provider System

The extension supports multiple image generation providers via a `ProviderDef` interface:

```typescript
interface ProviderDef {
  name: string;           // Display name
  keyEnv: string;         // Env var name (fallback)
  defaultModel: string;   // Default model
  baseUrl: string;        // API base URL
  path: string;           // Sync endpoint path
  asyncPath?: string;     // Async endpoint path (if different)
  openaiCompat: boolean;  // Uses OpenAI /v1/images/generations format
  forceAsync?: boolean;   // Always use async mode
  extraHeaders?: Record<string, string>;
  buildBody?: (params) => Record<string, unknown>;
  extractUrls?: (data) => string[];
}
```

Providers are defined in `PROVIDERS` constant. Each provider has:
- A synchronous API path
- An optional asynchronous API path (for task-based APIs like Aliyun)
- Custom `buildBody` for request formatting
- Custom `extractUrls` for response parsing

### Config File

Location: `~/.pi/agent/image-gen.json`

```json
{
  "apiKeys": {
    "aliyun": "sk-xxx"
  },
  "defaultModel": "wan2.7-image-pro"
}
```

- API keys are keyed by **provider id** (lowercase), NOT by environment variable name
- Environment variables (`DASHSCOPE_API_KEY`, `SILICONFLOW_API_KEY`, etc.) serve as fallback
- `getApiKey(providerId, envName)` checks config first, then env var

### Provider Resolution

`resolveProvider(providerArg, modelArg)` determines which provider to use:

1. If `providerArg` is specified → use that provider (must have key)
2. If `modelArg` or `cfg.defaultModel` is set → look up provider via `providerForModel()` from `KNOWN_MODELS` reverse map
3. First provider with a configured key

### Save System

The `save` parameter in `generate_image` controls disk saving:
- `"none"` — inline only (default)
- `"project"` — auto-name `image.png` → `image_1.png` → etc. in project root
- Any path string — save to specific path (e.g. `"output.png"`)

If the target file exists for a custom path, generation still succeeds but returns a `saveConflict` message. The agent should then use `save_image` with the returned handle.

### Handle System

Each generated image gets a human-readable handle like `猫_ab12` (first 8 chars of sanitized prompt + 4-char random suffix). Handles are cached in memory (up to 20 entries) and can be used with `save_image` tool or `/image-save` command to re-save later.

### Image Cache

The `imageCache` Map stores generated image data in memory. Auto-evicts oldest entries when size exceeds 20. Lost on extension reload (ephemeral).

---

## Aliyun Bailian API Details

### Endpoints

| Mode | Endpoint |
|------|----------|
| Sync (Wan2.7, Qwen-Image) | `POST /api/v1/services/aigc/multimodal-generation/generation` |
| Async creation | `POST /api/v1/services/aigc/image-generation/generation` + header `X-DashScope-Async: enable` |
| Async poll | `GET /api/v1/tasks/{task_id}` |

**Note**: The sync and async endpoints have DIFFERENT paths (`multimodal-generation` vs `image-generation`).

### Request Format (Sync)

```json
{
  "model": "wan2.7-image-pro",
  "input": {
    "messages": [{
      "role": "user",
      "content": [{ "text": "prompt" }]
    }]
  },
  "parameters": {
    "size": "1024*1024",
    "n": 1,
    "watermark": false,
    "thinking_mode": false
  }
}
```

### Response Format

```json
{
  "output": {
    "choices": [{
      "message": {
        "content": [{ "image": "https://...", "type": "image" }]
      }
    }]
  }
}
```

Sync and async poll responses share the same content structure.

### Model-Specific Parameters

| Model | Parameters | Notes |
|-------|-----------|-------|
| wan2.7-image-pro | `size`(1K/2K/4K), `thinking_mode`, `watermark` | Default model |
| qwen-image-2.0-pro | `size`(宽*高), `prompt_extend`, `watermark`, `n`(1-6) | No `thinking_mode` |
| z-image-turbo | `size`, `prompt_extend` | No `watermark` |

---

## Known pi Bugs

### Issue #2874 — Tab completion doesn't show argument completions

After Tab-completing a command, the autocomplete list disappears. Pressing Tab again triggers **file** completion, not argument completion.

**Workaround**: Type a character after the space to trigger argument completions. Pi's character insertion handler calls `tryTriggerAutocomplete()`, which pulls up the correct completions.

### Issue #2938 — Autocomplete doesn't continue after accepting command

Same root cause. Tab-accept calls `cancelAutocomplete()` and never re-triggers for arguments.

---

## Development Workflow

1. Edit `pi-image-gen.ts`
2. Copy to `~/.pi/agent/extensions/pi-image-gen.ts`
3. In pi session: `/reload`
4. Test with tool call or command

For debugging config saves:
```bash
cat ~/.pi/agent/image-gen.json
node -e "
const c = JSON.parse(require('fs').readFileSync(
  require('path').join(require('os').homedir(), '.pi', 'agent', 'image-gen.json'), 'utf-8'));
console.log(JSON.stringify(c, null, 2));
"
```

## Testing

- `generate_image` tool — generates image, returns base64 data for inline display
- `save_image(handle, filePath)` — re-saves a cached image
- `/image-gen model <name>` — sets default model (write to config file)
- `/image-gen key <provider> <key>` — sets API key
- `/image-gen` — shows status

## Adding a New Provider

1. Add entry to `PROVIDERS` with API endpoint info
2. If not OpenAI-compatible, implement `buildBody` and `extractUrls`
3. Add known models to `KNOWN_MODELS` for tab completion and provider detection
4. Test with a real API key
