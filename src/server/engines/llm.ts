import { curl } from "./http.js";
import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// LLM (ollama / OpenAI-compatible)
// ---------------------------------------------------------------------------
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatWithLLM(
  messages: ChatMessage[],
  settings: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  },
  opts?: { json?: boolean }
): Promise<string> {
  const url = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const bodyObj: any = { model: settings.model, messages, stream: false };
  if (opts?.json) {
    if (/ollama|11434/.test(settings.baseUrl)) bodyObj.format = "json";
    else bodyObj.response_format = { type: "json_object" };
  }
  const body = JSON.stringify(bodyObj);
  const headers = [
    "-H", "Content-Type: application/json",
    ...(settings.apiKey ? ["-H", `Authorization: Bearer ${settings.apiKey}`] : []),
  ];
  const { stdout, code } = await curl(["-X", "POST", ...headers, "-d", body, url]);
  if (code >= 400) throw new Error(`LLM request failed (${code}): ${stdout.toString().slice(0, 200)}`);
  const raw = stdout.toString();
  if (!raw.trim()) {
    throw new Error(`LLM endpoint returned an empty response — cannot connect to ${url}. Is the server running and reachable?`);
  }
  const data = JSON.parse(raw);
  const msg = data?.choices?.[0]?.message || {};
  // Unsloth's OpenAI-compatible server sometimes returns the reply in
  // `reasoning_content` with an empty `content` (its reasoning-model quirk).
  // Prefer `content`, but fall back to `reasoning_content` so we never return
  // a blank message when the model actually answered.
  return msg.content || msg.reasoning_content || "";
}

/**
 * 流式版本：spawn curl -N（不缓冲），解析 OpenAI 兼容 SSE，逐个 content
 * delta 作为字符串推给 ReadableStream。宿主路由把它转成 text/plain 流，
 * 前端即可实现打字机效果。cancel 时杀掉 curl 子进程。
 */
export function chatWithLLMStream(
  messages: ChatMessage[],
  settings: {
    baseUrl: string;
    model: string;
    apiKey?: string;
  }
): ReadableStream<string> {
  const url = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: settings.model,
    messages,
    stream: true,
    temperature: 0.7,
  });
  const args = [
    "-sS",
    "-N",
    "--max-time",
    "180",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    ...(settings.apiKey ? ["-H", `Authorization: Bearer ${settings.apiKey}`] : []),
    "-d",
    body,
    url,
  ];
  const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });

  return new ReadableStream<string>({
    start(controller) {
      let buf = "";
      let enqueued = false;
      let errTail = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const d = j.choices?.[0]?.delta || {};
            const delta = d.content || d.reasoning_content || "";
            if (delta) {
              enqueued = true;
              controller.enqueue(delta);
            }
          } catch {
            /* 非 JSON 数据行 — 跳过 */
          }
        }
      });
      child.stderr.on("data", (c: Buffer) => {
        // 保存 curl 报错尾部，供「空响应」时给出可读错误
        errTail = (errTail + c.toString()).slice(-300);
      });
      child.on("error", (err) => controller.error(err));
      child.on("close", (code) => {
        // 残留的非 SSE 文本（如 curl 报错）作为错误抛出
        const rest = buf.trim();
        if (rest && !rest.startsWith("data:")) {
          controller.error(new Error(rest.slice(0, 200)));
          return;
        }
        // 一个 token 都没流出来 → 视为失败（未配置/连不上/空响应）
        if (!enqueued) {
          const why =
            errTail.trim() ||
            (code !== 0
              ? `curl exited ${code}`
              : `empty response from LLM endpoint (${url}) — check Settings → LLM (Base URL / Model / Key)`);
          controller.error(new Error(why.slice(0, 200)));
          return;
        }
        controller.close();
      });
    },
    cancel() {
      child.kill();
    },
  });
}
