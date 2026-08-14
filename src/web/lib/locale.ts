/** Simple EN/ZH locale — pure functions, zero React dependency.
 *  Switch language: switchLang("zh") writes localStorage and reloads.
 *  Components: t("key") reads localStorage at render time. */

const DICT: Record<string, Record<string, string>> = {
  en: {
    audio: "Audio", video: "Video", read: "Read",
    words: "Words", chat: "Chat", settings: "Settings",
    resources: "Resources", transcript: "Transcript", layout: "Layout",
    content: "Content", save: "Save", delete: "Delete",
    confirm: "Confirm", test: "Test", import: "Import",
    play: "Play", pause: "Pause", stop: "Stop",
    readAloud: "Read aloud", playing: "Playing…",
    new: "New", loading: "Loading…",
    noContent: "No content yet.", importHelp: "Import a text file or URL to get started.",
    deployModel: "Deploy locally", deploying: "Deploying…",
    ready: "Ready", failed: "Failed", language: "Language",
  },
  zh: {
    audio: "音频", video: "视频", read: "阅读",
    words: "词汇", chat: "对话", settings: "设置",
    resources: "资源", transcript: "文本", layout: "分析",
    content: "内容", save: "保存", delete: "删除",
    confirm: "确认", test: "测试", import: "导入",
    play: "播放", pause: "暂停", stop: "停止",
    readAloud: "朗读", playing: "播放中…",
    new: "新建", loading: "加载中…",
    noContent: "暂无内容。", importHelp: "上传文本文件或输入网址开始阅读。",
    deployModel: "本地部署", deploying: "部署中…",
    ready: "就绪", failed: "失败", language: "语言",
  },
};

export type LocaleKey = keyof typeof DICT.en;

export function t(key: LocaleKey): string {
  const lang = localStorage.getItem("lingo-ui-lang") === "zh" ? "zh" : "en";
  return DICT[lang]?.[key] || DICT.en[key] || key;
}

export function switchLang(lang: "en" | "zh") {
  localStorage.setItem("lingo-ui-lang", lang);
  window.location.reload();
}
