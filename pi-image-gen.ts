/**
 * pi-image-gen.ts
 *
 * 生图工具 — 单文件 Pi Extension
 *
 * 参考:
 *   - packages/coding-agent/examples/extensions/antigravity-image-gen.ts
 *   - jvm/pi-codex-image-gen
 *
 * 支持:
 *   阿里云百炼  - DASHSCOPE_API_KEY (config/env)
 *   硅基流动    - SILICONFLOW_API_KEY (config/env)
 *   腾讯混元    - TENCENT_HUNYUAN_API_KEY (config/env)
 *   OpenAI 兼容  - OPENAI_API_KEY (config/env)
 *
 * 安装:
 *   pi install /path/to/pi-image-gen.ts
 *   或复制到 ~/.pi/agent/extensions/ 后用 /reload
 *
 * 配置:
 *   /image-gen key aliyun sk-xxx   设置 API key
 *   /image-gen model wan2.7-image-pro  设置默认模型（自动识别 provider）
 *   或环境变量 export DASHSCOPE_API_KEY=sk-xxx
 *   或文件 ~/.pi/agent/image-gen.json
 *
 * save 参数:
 *   save=none       - 不存盘，仅 inline 渲染
 *   save=project    - 自动命名存工程根目录，防覆盖
 *   save=<path>     - 存到指定路径，如 save=output.png 或 save=/abs/path/img.png
 *   默认 save=none。agent 应主动提供 save 参数。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ══════════════════════════════════════════════════════════
//  Config
// ══════════════════════════════════════════════════════════

const CONFIG_PATH = join(homedir(), ".pi", "agent", "image-gen.json");

interface Config {
  /** API keys keyed by provider id, e.g. { "aliyun": "sk-xxx" } */
  apiKeys?: Record<string, string>;
  /** Default model name (provider auto-detected from model name) */
  defaultModel?: string;
  /** Default save mode */
  save?: SaveMode;
}

type SaveMode = "none" | "project";

/**
 * Parse save parameter.
 * - "none" | undefined → no save
 * - "project" → auto-name in cwd, no overwrite
 * - anything else → treated as file path (relative to cwd or absolute)
 */
async function resolveSaveDest(saveParam: string | undefined, cwd: string, ext: string): Promise<{ save: boolean; filePath?: string; conflict?: boolean }> {
  if (!saveParam || saveParam === "none") return { save: false };

  let dir: string;

  if (saveParam === "project") {
    dir = cwd;
  } else {
    // Treat as file path — check for overwrite
    const filePath = saveParam.startsWith("/") ? saveParam : join(cwd, saveParam);
    if (existsSync(filePath)) {
      // Don't throw — generation succeeded, save skipped due to conflict
      return { save: false, conflict: true, filePath };
    }
    return { save: true, filePath };
  }

  // Auto-name with collision avoidance
  await mkdir(dir, { recursive: true });
  let filename = `image.${ext}`;
  let filePath = join(dir, filename);
  for (let attempt = 1; existsSync(filePath); attempt++) {
    filename = `image_${attempt}.${ext}`;
    filePath = join(dir, filename);
  }
  return { save: true, filePath };
}

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Config;
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Look up API key: config file (by provider id) → env var (by standard key name).
 * Config file uses provider id: { "aliyun": "sk-xxx" }
 * Env var uses standard names: DASHSCOPE_API_KEY, SILICONFLOW_API_KEY, etc.
 */
function getApiKey(providerId: string, envName: string): string | undefined {
  const cfg = loadConfig();
  // Config file: keyed by provider id
  if (cfg.apiKeys?.[providerId]) return cfg.apiKeys[providerId];
  // Fallback: env var
  if (typeof process !== "undefined" && process.env?.[envName]) return process.env[envName];
  return undefined;
}

// ══════════════════════════════════════════════════════════
//  Providers
// ══════════════════════════════════════════════════════════

interface ProviderDef {
  name: string;
  keyEnv: string;
  defaultModel: string;
  baseUrl: string;
  path: string;
  asyncPath?: string;
  openaiCompat: boolean;
  forceAsync?: boolean;
  extraHeaders?: Record<string, string>;
  buildBody?: (params: {
    model: string;
    prompt: string;
    size: string;
    n: number;
    negativePrompt?: string;
    style?: string;
  }) => Record<string, unknown>;
  extractUrls?: (data: Record<string, unknown>) => string[];
}

const PROVIDERS: Record<string, ProviderDef> = {
  aliyun: {
    name: "阿里云百炼",
    keyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "wan2.7-image-pro",
    baseUrl: "https://dashscope.aliyuncs.com",
    path: "/api/v1/services/aigc/multimodal-generation/generation",
    asyncPath: "/api/v1/services/aigc/image-generation/generation",
    openaiCompat: false,
    forceAsync: false,
    extraHeaders: { "X-DashScope-Async": "enable" },
    buildBody: ({ model, prompt, size, n, negativePrompt }) => {
      const params: Record<string, unknown> = { n };
      if (negativePrompt) params.negative_prompt = negativePrompt;

      // z-image-turbo doesn't use watermark/thinking_mode
      if (model?.startsWith("z-image")) {
        params.size = size.includes("*") ? size : normalizeAliyunSize(size);
        params.prompt_extend = false;
      } else if (model?.startsWith("qwen-image")) {
        // qwen-image: no size param, watermark handled here
        params.watermark = false;
      } else {
        // wan2.7 defaults
        params.size = normalizeAliyunSize(size);
        params.watermark = false;
        params.thinking_mode = false;
      }

      return {
        model,
        input: {
          messages: [{ role: "user", content: [{ text: prompt }] }],
        },
        parameters: params,
      };
    },
    extractUrls: (data) => {
      const output = data.output as Record<string, unknown> | undefined;
      if (!output) return [];
      const choices = output.choices as Array<Record<string, unknown>> | undefined;
      if (!choices) return [];
      const urls: string[] = [];
      for (const choice of choices) {
        const msg = choice.message as Record<string, unknown> | undefined;
        if (!msg) continue;
        const content = msg.content as Array<Record<string, unknown>> | undefined;
        if (!content) continue;
        for (const item of content) {
          if (typeof item.image === "string") urls.push(item.image);
        }
      }
      return urls;
    },
  },
  siliconflow: {
    name: "硅基流动",
    keyEnv: "SILICONFLOW_API_KEY",
    defaultModel: "black-forest-labs/FLUX.1-dev",
    baseUrl: "https://api.siliconflow.cn",
    path: "/v1/images/generations",
    openaiCompat: true,
  },
  tencent: {
    name: "腾讯混元",
    keyEnv: "TENCENT_HUNYUAN_API_KEY",
    defaultModel: "hunyuan-image",
    baseUrl: "https://api.hunyuan.cloud.tencent.com",
    path: "/v1/images/generations",
    openaiCompat: true,
  },
  openai: {
    name: "OpenAI 兼容",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "dall-e-3",
    baseUrl: "https://api.openai.com",
    path: "/v1/images/generations",
    openaiCompat: true,
  },
};

function resolveProvider(providerArg: string | undefined, modelArg: string | undefined): { id: string; def: ProviderDef } | null {
  const cfg = loadConfig();

  // 1. Explicit provider argument
  if (providerArg) {
    const p = PROVIDERS[providerArg];
    if (!p || !getApiKey(providerArg, p.keyEnv)) return null;
    return { id: providerArg, def: p };
  }

  // 2. Model name → look up provider
  const model = modelArg || cfg.defaultModel;
  if (model) {
    const provId = providerForModel(model);
    if (provId && PROVIDERS[provId] && getApiKey(provId, PROVIDERS[provId].keyEnv)) {
      return { id: provId, def: PROVIDERS[provId] };
    }
  }

  // 3. First provider with a configured key
  for (const id of Object.keys(PROVIDERS)) {
    if (getApiKey(id, PROVIDERS[id].keyEnv)) {
      return { id, def: PROVIDERS[id] };
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════
//  Image generation
// ══════════════════════════════════════════════════════════

const SIZE_MAP: Record<string, string> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:2": "1024x683",
  "16:9": "1024x576",
  "9:16": "576x1024",
  "21:9": "1024x439",
};

// ── Known models for tab completion and provider lookup ──
const KNOWN_MODELS: Record<string, string[]> = {
  aliyun: [
    "wan2.7-image-pro",
    "qwen-image-2.0-pro",
    "qwen-image-2.0-pro-2026-04-22",
    "z-image-turbo",
  ],
  // siliconflow: ["black-forest-labs/FLUX.1-dev"],
  // tencent: ["hunyuan-image"],
  // openai: ["dall-e-3"],
};

/** Look up which provider a model belongs to */
function providerForModel(model: string): string | undefined {
  for (const [prov, models] of Object.entries(KNOWN_MODELS)) {
    if (models.includes(model)) return prov;
  }
  return undefined;
}

function normalizeAliyunSize(size: string): string {
  if (/^\d+K$/i.test(size)) return size.toUpperCase();
  return size.replace(/[xX×]/g, "*");
}

async function submitAsyncTask(prov: ProviderDef, body: Record<string, unknown>, apiKey: string, signal: AbortSignal): Promise<string[]> {
  const asyncUrl = `${prov.baseUrl}${prov.asyncPath || prov.path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(prov.extraHeaders ?? {}),
  };
  const resp = await fetch(asyncUrl, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`创建异步任务失败 (${resp.status}): ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  const taskId = (data.output as Record<string, unknown> | undefined)?.task_id as string | undefined;
  if (!taskId) throw new Error("异步任务未返回 task_id");

  const pollUrl = `${prov.baseUrl}/api/v1/tasks/${taskId}`;
  for (let i = 0; i < 60; i++) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      const onAbort = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (signal.aborted) throw new Error("任务已被取消");

    const pollResp = await fetch(pollUrl, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!pollResp.ok) {
      const text = await pollResp.text().catch(() => "");
      throw new Error(`轮询任务状态失败 (${pollResp.status}): ${text.slice(0, 300)}`);
    }
    const pollData = await pollResp.json() as Record<string, unknown>;
    const output = pollData.output as Record<string, unknown> | undefined;
    const taskStatus = output?.task_status as string | undefined;

    if (taskStatus === "SUCCEEDED") {
      if (prov.extractUrls) {
        const urls = prov.extractUrls(pollData);
        if (urls.length > 0) return urls;
      }
      throw new Error("任务已完成但响应中未找到图片");
    }
    if (taskStatus === "FAILED") {
      const msg = (output?.results as Array<Record<string, unknown>> | undefined)?.[0]?.message || JSON.stringify(output).slice(0, 300);
      throw new Error(`任务失败: ${msg}`);
    }
  }
  throw new Error("任务轮询超时");
}

function extractOpenaiUrls(data: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.url === "string") urls.push(obj.url);
        if (typeof obj.b64_json === "string") urls.push(`data:image/png;base64,${obj.b64_json}`);
      }
    }
  }
  return urls;
}

async function fetchImageUrls(prov: ProviderDef, body: Record<string, unknown>, apiKey: string, signal: AbortSignal): Promise<string[]> {
  if (prov.forceAsync && prov.asyncPath) {
    return submitAsyncTask(prov, body, apiKey, signal);
  }
  const syncResp = await fetch(`${prov.baseUrl}${prov.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (syncResp.ok) {
    const data = await syncResp.json();
    const urls = prov.extractUrls ? prov.extractUrls(data) : extractOpenaiUrls(data);
    return urls;
  }
  if (syncResp.status === 403 && prov.asyncPath) {
    const errText = await syncResp.text().catch(() => "");
    if (errText.includes("does not support synchronous calls")) {
      return submitAsyncTask(prov, body, apiKey, signal);
    }
    throw new Error(`API 返回错误 (${syncResp.status}): ${errText.slice(0, 500)}`);
  }
  const text = await syncResp.text().catch(() => "");
  throw new Error(`API 返回错误 (${syncResp.status}): ${text.slice(0, 500)}`);
}

interface GenResult {
  urls: string[];
  providerName: string;
  providerModel: string;
  imageData: Buffer | null;
  mimeType: string;
  savedPath: string | undefined;
  saveConflict: string | undefined;
}

async function generateImage(
  prompt: string,
  opts: {
    provider?: string;
    model?: string;
    size?: string;
    n?: number;
    negativePrompt?: string;
    style?: string;
    save?: string;
  },
  cwd: string,
): Promise<GenResult> {
  const picked = resolveProvider(opts.provider, opts.model);
  if (!picked) {
    const configured = Object.entries(PROVIDERS)
      .filter(([k, p]) => getApiKey(k, p.keyEnv))
      .map(([k, p]) => `${k}(${p.name})`)
      .join(", ");
    const msg = configured
      ? `未找到可用 provider，已配置: ${configured}`
      : "未配置任何 API key，请使用 /image-gen set <provider> <key> 配置";
    throw new Error(msg);
  }

  const prov = picked.def;
  const provId = picked.id;
  const cfg = loadConfig();
  const model = opts.model || cfg.defaultModel || prov.defaultModel;
  const size = SIZE_MAP[opts.size || ""] || opts.size || "1024x1024";
  const n = Math.min(opts.n || 1, 4);
  const apiKey = getApiKey(provId, prov.keyEnv);
  if (!apiKey) throw new Error(`${prov.name} 的 API key 未配置`);

  const styledPrompt = opts.style ? `${prompt}, ${opts.style} style` : prompt;

  const body = prov.buildBody
    ? prov.buildBody({ model, prompt: styledPrompt, size, n, negativePrompt: opts.negativePrompt, style: opts.style })
    : prov.openaiCompat
      ? { model, prompt: styledPrompt, n, size, ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}) }
      : { model, input: { prompt: styledPrompt }, parameters: { size: size.replace(/[xX×]/g, "*"), n, ...(opts.negativePrompt ? { negative_prompt: opts.negativePrompt } : {}) } };

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), 120_000);
  try {
    const urls = await fetchImageUrls(prov, body, apiKey, controller.signal);
    if (urls.length === 0) throw new Error("响应中没有图片数据");

    // Download the first image for inline display and optional disk save
    const imgResp = await fetch(urls[0], { signal: controller.signal });
    if (!imgResp.ok) {
      // URLs obtained but download failed — still report success with URLs
      return {
        urls, providerName: prov.name, providerModel: model,
        imageData: null, mimeType: "image/png", savedPath: undefined,
      };
    }
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    const mimeType = imgResp.headers.get("content-type") || "image/png";

    let savedPath: string | undefined;
    let saveConflict: string | undefined;
    try {
      const ext = mimeToExt(mimeType);
      const dest = await resolveSaveDest(opts.save, cwd, ext);
      if (dest.conflict) {
        saveConflict = `File already exists: ${dest.filePath}. Generation succeeded but file was not saved. Use save_image with the handle to save with a different name.`;
      } else if (dest.save && dest.filePath) {
        await mkdir(join(dest.filePath, ".."), { recursive: true });
        await writeFile(dest.filePath, imgBuffer);
        savedPath = dest.filePath;
      }
    } catch (saveErr) {
      console.error(`save failed: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
    }

    return { urls, providerName: prov.name, providerModel: model, imageData: imgBuffer, mimeType, savedPath, saveConflict };
  } finally {
    clearTimeout(timeoutTimer);
  }
}

function mimeToExt(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("png")) return "png";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("webp")) return "webp";
  return "png";
}

function truncatePrompt(prompt: string, maxLen: number = 80): string {
  if (prompt.length <= maxLen) return prompt;
  return prompt.slice(0, maxLen - 3) + "...";
}

// ── Image cache for re-saving by handle ──
const imageCache = new Map<string, { data: Buffer; mimeType: string; url: string; prompt: string; provider: string }>();
function cacheImage(data: Buffer, mimeType: string, url: string, prompt: string, provider: string): string {
  const prefix = prompt.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 8) || "img";
  const suffix = Math.random().toString(36).slice(2, 6);
  const handle = `${prefix}-${suffix}`;
  // Ensure uniqueness
  if (imageCache.has(handle)) return cacheImage(data, mimeType, url, prompt, provider);
  imageCache.set(handle, { data, mimeType, url, prompt, provider });
  if (imageCache.size > 20) {
    const firstKey = imageCache.keys().next().value;
    if (firstKey) imageCache.delete(firstKey);
  }
  return handle;
}

// ══════════════════════════════════════════════════════════
//  Extension
// ══════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  // ── tool: generate_image ──
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate an image from a text prompt. Supports 阿里云百炼, 硅基流动, 腾讯混元, " +
      "and OpenAI-compatible providers. Costs money per image. " +
      "Provider is auto-detected from configured API keys. " +
      "Use when the user asks to create, draw, or generate an image. " +
      "Returns a handle in details.handle that can be used with save_image to save later.",
    promptSnippet: "Generate images from text descriptions (use save_image with the returned handle to save later)",
    promptGuidelines: [
      "Use generate_image when the user asks to create, draw, or generate an image.",
      "Costs money per image — use when the user explicitly asks for image generation, or when the situation strongly implies it.",
      "Save to disk: save='<path>' (specific filename under project dir), save='project' (auto-name), or save='none' (inline only).",
      "Agent should normally save to a specific path under project directory with save='<path>'.",
      "The tool returns a handle (e.g. 'cat-a7f3') in details.handle. Use save_image with that handle to save the image later if not saved initially or if save failed due to name conflict.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description in natural language." }),
      provider: Type.Optional(Type.Union([
        Type.Literal("aliyun"), Type.Literal("siliconflow"),
        Type.Literal("tencent"), Type.Literal("openai"),
      ])),
      model: Type.Optional(Type.String({ description: "Model override. Common models: aliyun: wan2.7-image-pro, qwen-image-2.0-pro, z-image-turbo | siliconflow: FLUX.1-dev | tencent: hunyuan-image | openai: dall-e-3. Use /image-gen model for tab completion." })),
      size: Type.Optional(Type.String({ description: "Size preset: '1:1', '16:9', or '1024x1024'. Default: 1024x1024." })),
      n: Type.Optional(Type.Integer({ description: "Number of images. Default: 1." })),
      negativePrompt: Type.Optional(Type.String()),
      style: Type.Optional(Type.String({ description: "Style hint: 水墨, 油画, 写实, 卡通, etc." })),
      save: Type.Optional(Type.String({ description: "Save destination: 'none' (inline only), 'project' (auto-name in cwd), or a file path like 'output.png' or '/abs/path/img.png'." })),
    }),
    execute: async (_toolCallId: string, params: Record<string, unknown>, _signal, onUpdate, ctx) => {
      const prompt = (params.prompt as string)?.trim();
      if (!prompt) {
        throw new Error("No prompt provided. Specify an image description.");
      }

      // During generation: show the full prompt in the tool call box
      onUpdate?.({
        content: [{ type: "text", text: `image: ${prompt}` }],
        details: { status: "generating", prompt },
      });

      const result = await generateImage(prompt, {
        provider: params.provider as string | undefined,
        model: params.model as string | undefined,
        size: params.size as string | undefined,
        n: params.n as number | undefined,
        negativePrompt: params.negativePrompt as string | undefined,
        style: params.style as string | undefined,
        save: params.save as string | undefined,
      }, ctx.cwd);

      // Cache for re-saving by handle
      let handle: string | undefined;
      if (result.imageData && result.urls[0]) {
        handle = cacheImage(result.imageData, result.mimeType, result.urls[0], prompt, result.providerName);
      }

      // Final result: minimal, no prompt
      const summary = result.saveConflict
        ? `${result.providerName}/${result.providerModel}: generated, ${result.saveConflict}`
        : result.savedPath
          ? `saved: ${result.savedPath}`
          : `image: ${result.providerName}/${result.providerModel}`;
      const content: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }> = [
        { type: "text", text: summary },
      ];
      if (result.imageData) {
        content.push({
          type: "image",
          data: result.imageData.toString("base64"),
          mimeType: result.mimeType,
        });
      }

      const details: Record<string, unknown> = {
        handle,
        provider: result.providerName,
        model: result.providerModel,
        count: result.urls.length,
        urls: result.urls,
      };
      if (result.savedPath) details.savedPath = result.savedPath;
      if (result.saveConflict) details.saveConflict = result.saveConflict;

      return { content, details };
    },
  });

  // ── command: /imagine ──
  pi.registerCommand("imagine", {
    description: "Generate an image. Usage: /imagine <prompt> [--provider aliyun] [--save project]",
    handler: async (args: string, ctx) => {
      const trimmed = (args || "").trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /imagine <description> [--provider aliyun] [--save output.png] [--size 16:9]",
          "info"
        );
        return;
      }

      const argList = trimmed.split(/\s+/);
      const opts: Record<string, string> = {};
      const promptParts: string[] = [];
      for (let i = 0; i < argList.length; i++) {
        if (argList[i].startsWith("--")) {
          const key = argList[i].slice(2);
          opts[key] = (argList[i + 1] && !argList[i + 1].startsWith("--")) ? argList[++i] : "";
        } else {
          promptParts.push(argList[i]);
        }
      }

      ctx.ui.notify(`image: ${promptParts.join(" ").slice(0, 80)}`, "info");
      try {
        const result = await generateImage(promptParts.join(" "), {
          provider: opts.provider, model: opts.model, size: opts.size, style: opts.style, save: opts.save,
        }, ctx.cwd);

        // Cache for re-saving by handle
        let handle: string | undefined;
        if (result.imageData && result.urls[0]) {
          handle = cacheImage(result.imageData, result.mimeType, result.urls[0], promptParts.join(" "), result.providerName);
        }

        const summary = result.saveConflict
          ? `${result.providerName}/${result.providerModel}: ${result.saveConflict}`
          : result.savedPath
            ? `${result.providerName}/${result.providerModel} -> ${result.savedPath}`
            : `${result.providerName}/${result.providerModel}`;
        ctx.ui.notify(summary, "success");

        pi.sendMessage({
          customType: "image-gen",
          content: `${summary}\n\nhandle: ${handle || "none"}`,
          display: true,
          details: { provider: result.providerName, model: result.providerModel, urls: result.urls, savedPath: result.savedPath, handle },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`failed: ${msg}`, "error");
      }
    },
  });

  // ── tool: save_image ──
  pi.registerTool({
    name: "save_image",
    label: "Save Image",
    description:
      "Save a previously generated image (identified by its handle) to a file path. " +
      "The handle is returned by generate_image in details.handle. " +
      "Useful when the image was generated without save or needs to be copied to another location.",
    promptSnippet: "Save a previously generated image by handle to a file path",
    promptGuidelines: [
      "Use save_image when the user wants to save a previously generated image (referenced by handle from generate_image) to disk.",
    ],
    parameters: Type.Object({
      handle: Type.String({ description: "Image handle returned by generate_image (e.g. 'cat-a7f3')." }),
      filePath: Type.String({ description: "Absolute path or relative path (from working directory) to save the image to." }),
    }),
    execute: async (_toolCallId: string, params: Record<string, unknown>, _signal, _onUpdate, ctx) => {
      const handle = (params.handle as string)?.trim();
      if (!handle) throw new Error("handle is required.");

      const cached = imageCache.get(handle);
      if (!cached) {
        throw new Error(`Image handle "${handle}" not found. Available handles: ${[...imageCache.keys()].join(", ") || "none"}`);
      }

      const filePath = (params.filePath as string)?.trim();
      if (!filePath) throw new Error("filePath is required.");

      const resolvedPath = filePath.startsWith("/") ? filePath : join(ctx.cwd, filePath);
      const dir = join(resolvedPath, "..");
      await mkdir(dir, { recursive: true });
      if (existsSync(resolvedPath)) {
        throw new Error(`File already exists: ${resolvedPath}. Ask the user whether to overwrite or choose a different path.`);
      }
      await writeFile(resolvedPath, cached.data);

      return {
        content: [{ type: "text" as const, text: `Image "${handle}" (${cached.prompt}) saved to ${resolvedPath}` }],
        details: { savedPath: resolvedPath, handle, url: cached.url },
      };
    },
  });

  // ── command: /image-save ──
  pi.registerCommand("image-save", {
    description: "Save a previously generated image by handle. Usage: /image-save <handle> <path> | /image-save list",
    handler: async (args: string, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      if (parts.length === 0 || parts[0] === "") {
        ctx.ui.notify("Usage: /image-save <handle> <file_path> | /image-save list", "info");
        return;
      }

      if (parts[0] === "list") {
        if (imageCache.size === 0) {
          ctx.ui.notify("No cached images.", "info");
          return;
        }
        const lines = [...imageCache.entries()].map(
          ([h, img]) => `  ${h}: "${truncatePrompt(img.prompt, 60)}" (${img.provider})`
        );
        ctx.ui.notify(`Cached images:\n${lines.join("\n")}`, "info");
        return;
      }

      const handle = parts[0];
      const cached = imageCache.get(handle);
      if (!cached) {
        ctx.ui.notify(`Handle "${handle}" not found. Run /image-save list to see available handles.`, "warning");
        return;
      }

      const filePath = parts.slice(1).join(" ").trim();
      if (!filePath) {
        ctx.ui.notify("Usage: /image-save <handle> <file_path>", "info");
        return;
      }

      try {
        const resolvedPath = filePath.startsWith("/") ? filePath : join(ctx.cwd, filePath);
        const dir = join(resolvedPath, "..");
        await mkdir(dir, { recursive: true });
        if (existsSync(resolvedPath)) {
          ctx.ui.notify(`File already exists: ${resolvedPath}`, "warning");
          return;
        }
        await writeFile(resolvedPath, cached.data);
        ctx.ui.notify(`Image "${handle}" saved to ${resolvedPath}`, "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Save failed: ${msg}`, "error");
      }
    },
  });

  // ── command: /image-gen ──
  pi.registerCommand("image-gen", {
    description: "Usage: /image-gen | /image-gen model <name> | /image-gen key <provider> <key>",
    getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
      const p = prefix || "";
      const spaceAt = p.indexOf(" ");
      
      // No space yet: first level — offer subcommands
      if (spaceAt === -1) {
        const items = [
          { value: "model", label: "model <name>" },
          { value: "key", label: "key <provider> <key>" },
        ];
        return items.filter((i) => i.value.startsWith(p));
      }

      // Has space: second level — based on first word
      const first = p.slice(0, spaceAt);
      const rest = p.slice(spaceAt + 1);

      if (first === "model") {
        const items: AutocompleteItem[] = [];
        for (const [, models] of Object.entries(KNOWN_MODELS)) {
          for (const m of models) items.push({ value: `model ${m}`, label: m });
        }
        return items.filter((i) => i.label.startsWith(rest));
      }

      if (first === "key") {
        return Object.keys(PROVIDERS)
          .filter((id) => id.startsWith(rest))
          .map((id) => ({ value: `key ${id}`, label: id }));
      }

      return null;
    },
    handler: async (args: string, ctx) => {
      const CFG = join(homedir(), ".pi", "agent", "image-gen.json");
      const parts = (args || "").trim().split(/\s+/);
      const cmd = parts[0] || "";

      if (cmd === "key" && parts[1] && parts[2]) {
        if (!Object.keys(PROVIDERS).includes(parts[1])) {
          ctx.ui.notify(`unknown: ${parts[1]}`, "warning");
          return;
        }
        let data: any = {};
        try { if (existsSync(CFG)) data = JSON.parse(readFileSync(CFG, "utf-8")); } catch {}
        if (!data.apiKeys) data.apiKeys = {};
        data.apiKeys[parts[1]] = parts.slice(2).join(" ");
        mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
        writeFileSync(CFG, JSON.stringify(data, null, 2), "utf-8");
        ctx.ui.notify(`key saved for ${parts[1]}`, "info");
        return;
      }

      if (cmd === "model" && parts[1]) {
        let data: any = {};
        try { if (existsSync(CFG)) data = JSON.parse(readFileSync(CFG, "utf-8")); } catch {}
        data.defaultModel = parts[1];
        mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
        writeFileSync(CFG, JSON.stringify(data, null, 2), "utf-8");
        const check = JSON.parse(readFileSync(CFG, "utf-8"));
        ctx.ui.notify(`set model: ${check.defaultModel}`, "info");
        return;
      }

      let data: any = {};
      try { if (existsSync(CFG)) data = JSON.parse(readFileSync(CFG, "utf-8")); } catch {}
      const lines = Object.entries(PROVIDERS).map(([id, p]) => {
        return `  ${getApiKey(id, p.keyEnv) ? "[ok]" : "[--]"} ${p.name} (${id})`;
      });
      ctx.ui.notify(`image-gen\n${lines.join("\n")}\n\nmodel: ${data.defaultModel || "not set"}`, "info");
    },
  });
}
