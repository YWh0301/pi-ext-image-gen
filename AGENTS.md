# pi-image-gen — 开发笔记

## Pi Extension 开发坑点

### 1. `registerCommand` 的 handler 参数是 string，不是 string[]

```typescript
// ❌ 错误
handler: async (args, ctx) => {
  if (args[0] === "model") { ... }  // args 是字符串，args[0] 取到第一个字符 "m"
}

// ✅ 正确
handler: async (args: string, ctx) => {
  const parts = (args || "").trim().split(/\s+/);
  if (parts[0] === "model") { ... }
}
```

`args` 是整个参数区的字符串，不是按空格分割的数组。所有示例代码中 `args` 都是 `string` 类型，参考 `multimodal-proxy` 和 `commands.ts`。

### 2. `getArgumentCompletions` 的多级补全有 bug

**Issue #2874**: pi 在 Tab 补全命令后关闭 autocomplete 状态，再按 Tab 不会触发参数补全，而是触发文件补全。

**Issue #2938**: Tab 接受命令后加了后缀空格，但不会自动触发下一级参数补全。

**规律**：输入**字符**可以触发参数补全（pi 的字符插入处理器会调用 `tryTriggerAutocomplete`），但按 Tab 不行。

**解决方案**：
- 所有补全项目用扁平列表（单层），避免依赖二级补全
- 或者告诉用户先打首字母再补全
- 补全的 `value` 要带上完整的命令前缀（如 `"model qwen-image-2.0-pro"`），否则可能会替换掉前面的子命令

### 3. `registerCommand` 的 `getArgumentCompletions` 不能是 async

Issue #2719: `async getArgumentCompletions` 会导致 pi 崩溃。虽然 0.64.0 修了，但最好还是同步。

### 4. `registerTool` 的 execute 参数签名

```typescript
execute: async (toolCallId, params, signal, onUpdate, ctx) => { ... }
```

- `toolCallId`: string
- `params`: Record<string, unknown> — 工具参数
- `signal`: AbortSignal — 取消信号
- `onUpdate`: 用于在 tool call 框中显示中间状态
- `ctx`: ExtensionContext — 当前上下文

### 5. 错误处理：throw 才能让 tool call 框变红

```typescript
// ❌ 框是绿的（框架以为是成功）
return { content: [{ type: "text", text: "生成失败: xxx" }], details: { error: "xxx" } };

// ✅ 框变红（框架设 isError = true）
throw new Error("生成失败: xxx");
```

### 6. 图片返回格式：inline data 才能在 TUI 渲染

```typescript
// ❌ URL 方式，TUI 不一定能渲染
{ type: "image", url: "https://..." }

// ✅ inline data 方式，TUI 直接显示
{ type: "image", data: base64String, mimeType: "image/png" }
```

参考 `antigravity-image-gen.ts`。

### 7. `ctx.ui.notify` 在非 TUI 模式下是 no-op

在 `-p`（print）模式下，`ctx.ui.notify` 不输出任何内容。测试扩展时要进交互模式。

---

## 阿里云百炼 API 坑点

### 1. 万相 Wan2.7 的 API 端点

**同步调用**：
```
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

请求体：
```json
{
  "model": "wan2.7-image-pro",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [{ "text": "prompt here" }]
      }
    ]
  },
  "parameters": {
    "size": "1024*1024",
    "n": 1,
    "watermark": false,
    "thinking_mode": false
  }
}
```

**异步调用**（不同端点！）：
```
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation
Header: X-DashScope-Async: enable
```

轮询：
```
GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}
```

**注意**：同步端点是 `multimodal-generation`，异步端点是 `image-generation`，不一样。

### 2. API Key 分地域

北京和新加坡的 API Key 和请求地址不同，不能混用。新加坡建议用业务空间专属域名：
```
https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com
```

### 3. 尺寸参数

- Wan2.7 系列：支持 `1K`、`2K`（默认）、`4K`（pro 模型文生图）
- qwen-image 系列：总像素 512*512~2048*2048
- 自定义尺寸用 `*` 分隔：`1024*1024`
- OpenAI 兼容 API 用 `x`：`1024x1024`

### 4. 模型间参数差异

| 模型 | 关键参数 |
|------|---------|
| wan2.7-image-pro | `thinking_mode`, `watermark`, `size`(1K/2K/4K) |
| qwen-image-2.0-pro | `watermark`, `prompt_extend`, `size`(宽*高), 支持 n=1-6 |
| z-image-turbo | `prompt_extend`, `size`, 无 `watermark`/`thinking_mode` |

### 5. 响应格式

同步和异步轮询的响应结构一致：
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

--- 

## 配置文件设计

```json
{
  "apiKeys": {
    "aliyun": "sk-xxx",
    "siliconflow": "sk-yyy"
  },
  "defaultModel": "wan2.7-image-pro"
}
```

- API key 用小写 provider id 做 key（不是大写的环境变量名）
- 环境变量作为后备（`DASHSCOPE_API_KEY` 等）
- 当前只适配了阿里云百炼，其他 provider 的 API 未测试

## 命名规范

- handle 用 prompt 前缀 + 4位随机：`猫_ab12`
- 文件名用 `image.png`，重名自动 `image_1.png`、`image_2.png`
- 所有用户可见文案用英文，简洁专业
