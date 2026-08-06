import { curl } from "./http.js";

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
  return data?.choices?.[0]?.message?.content || "";
}
