const $ = (id) => document.getElementById(id);
const APP_BUILD = "2026-04-23-2";

const el = {
  createProjectBtn: $("createProjectBtn"),
  projectList: $("projectList"),
  projectNameLabel: $("projectNameLabel"),
  visualStyleInput: $("visualStyleInput"),
  saveVisualStyleBtn: $("saveVisualStyleBtn"),
  runLog: $("runLog"),
  settingsNavBtn: $("settingsNavBtn"),
  closeSettingsBtn: $("closeSettingsBtn"),
  logoutBtn: $("logoutBtn"),
  mePhone: $("mePhone"),
  pointsBalanceText: $("pointsBalanceText"),
  pointsSpentText: $("pointsSpentText"),
  tokenUsageText: $("tokenUsageText"),
  lastUsageText: $("lastUsageText"),
  billingLogsText: $("billingLogsText"),
  billingWarnText: $("billingWarnText"),
  refreshBillingBtn: $("refreshBillingBtn"),
  oldPasswordInput: $("oldPasswordInput"),
  newPasswordInput: $("newPasswordInput"),
  openChangePasswordBtn: $("openChangePasswordBtn"),
  changePasswordModal: $("changePasswordModal"),
  closeChangePasswordBtn: $("closeChangePasswordBtn"),
  cancelChangePasswordBtn: $("cancelChangePasswordBtn"),
  confirmChangePasswordBtn: $("confirmChangePasswordBtn"),
  changePasswordError: $("changePasswordError"),
  textModelSelect: $("textModelSelect"),
  imageModelSelect: $("imageModelSelect"),
  imageAspectRatioSelect: $("imageAspectRatioSelect"),
  saveModelBtn: $("saveModelBtn"),
  openAiChatBtn: $("openAiChatBtn"),
  aiChatModal: $("aiChatModal"),
  closeAiChatBtn: $("closeAiChatBtn"),
  aiChatMessages: $("aiChatMessages"),
  aiChatInput: $("aiChatInput"),
  aiChatImageModeCheck: $("aiChatImageModeCheck"),
  sendAiChatBtn: $("sendAiChatBtn"),
  clearAiChatBtn: $("clearAiChatBtn"),
  aiChatModelLabel: $("aiChatModelLabel"),
  adminEntryLink: $("adminEntryLink"),
  adminSettingsLink: $("adminSettingsLink"),
  adminTopbarLink: $("adminTopbarLink"),
  sidebarMenuBtn: $("sidebarMenuBtn"),
  sidebarBackdrop: $("sidebarBackdrop"),
  sidebarNav: $("sidebarNav"),
  tabButtons: Array.from(document.querySelectorAll(".tab-btn")),
  novelFileInput: $("novelFileInput"),
  novelTextInput: $("novelTextInput"),
  splitChaptersBtn: $("splitChaptersBtn"),
  appendChaptersBtn: $("appendChaptersBtn"),
  reSplitChaptersBtn: $("reSplitChaptersBtn"),
  extractOutlineBtn: $("extractOutlineBtn"),
  reExtractOutlineBtn: $("reExtractOutlineBtn"),
  selectAllChaptersBtn: $("selectAllChaptersBtn"),
  clearAllChaptersBtn: $("clearAllChaptersBtn"),
  chapterViewToggleBtn: $("chapterViewToggleBtn"),
  chapterCheckboxList: $("chapterCheckboxList"),
  outlineChapterSelect: $("outlineChapterSelect"),
  loadOutlineBtn: $("loadOutlineBtn"),
  saveOutlineBtn: $("saveOutlineBtn"),
  saveOutlineModuleBtn: $("saveOutlineModuleBtn"),
  exportOutlineBtn: $("exportOutlineBtn"),
  outlineCards: $("outlineCards"),
  outlineModuleTitle: $("outlineModuleTitle"),
  assetsChapterSelect: $("assetsChapterSelect"),
  loadAssetsBtn: $("loadAssetsBtn"),
  saveAssetsBtn: $("saveAssetsBtn"),
  saveAssetsModuleBtn: $("saveAssetsModuleBtn"),
  exportAssetsBtn: $("exportAssetsBtn"),
  generateCurrentChapterAssetsBtn: $("generateCurrentChapterAssetsBtn"),
  generateAssetsBtn: $("generateAssetsBtn"),
  generateAllAssetsBtn: $("generateAllAssetsBtn"),
  addAssetEntryBtn: $("addAssetEntryBtn"),
  polishAssetEntryBtn: $("polishAssetEntryBtn"),
  assetCards: $("assetCards"),
  assetModuleTitle: $("assetModuleTitle"),
  // Custom text model panel
  customTextEnable: $("customTextEnable"),
  customTextProvider: $("customTextProvider"),
  customTextBaseUrl: $("customTextBaseUrl"),
  customTextModelName: $("customTextModelName"),
  customTextApiKey: $("customTextApiKey"),
  customTextKeyStatus: $("customTextKeyStatus"),
  saveCustomTextBtn: $("saveCustomTextBtn"),
  clearCustomTextBtn: $("clearCustomTextBtn"),
};

const state = {
  projects: [],
  currentProjectId: null,
  workspace: { chapters: [] },
  selectedChapterIds: new Set(),
  loadedOutline: null,
  loadedAssets: null,
  outlineModule: "characters",
  assetModule: "characters",
  outlineCardsByModule: { characters: [], scenes: [], items: [], storyline: [] },
  assetCardsByModule: {
    characters: [],
    scenes: [],
    items: [],
    storyboard: [],
    storyboardPrompts: [],
    chapterText: [],
  },
  aiChatMessages: [],
  aiChatSending: false,
  billing: null,
};

let chapterCompactMode = true;   // default: grid/compact
let lastCheckedChapterIdx = -1;  // for shift+click range select

function log(msg) {
  el.runLog.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
}

function formatInt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  return Math.floor(x).toLocaleString("zh-CN");
}

function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString("zh-CN");
}

function jsonOrError(resp, text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function getJson(url) {
  let resp;
  try {
    resp = await fetch(url, { credentials: "include" });
  } catch (err) {
    const online = typeof navigator !== "undefined" ? navigator.onLine : true;
    throw new Error(`网络请求失败(GET ${url})：${err?.message || err}（online=${online}）`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    const data = jsonOrError(resp, text);
    const isHtml = /^\s*<!doctype html>/i.test(String(text || ""));
    throw new Error(data?.error || (isHtml ? `接口不存在或服务未重启：GET ${url} (HTTP ${resp.status})` : text) || `HTTP ${resp.status}`);
  }
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollTask(taskId, queueName, progressCallback) {
  while (true) {
    await sleep(2000);
    const res = await getJson(`/api/tasks/${taskId}?queue=${queueName}`);
    if (!res.ok || !res.status) throw new Error("Task polling failed");
    if (progressCallback && Number.isFinite(res.status.progress)) {
      progressCallback(res.status.progress);
    }
    if (res.status.state === "completed") {
      return res.status.returnvalue;
    }
    if (res.status.state === "failed") {
      throw new Error(res.status.failedReason || "任务执行失败");
    }
  }
}

async function postJson(url, body) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "include",
    });
  } catch (err) {
    const online = typeof navigator !== "undefined" ? navigator.onLine : true;
    throw new Error(`网络请求失败(POST ${url})：${err?.message || err}（online=${online}）`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    const data = jsonOrError(resp, text);
    const isHtml = /^\s*<!doctype html>/i.test(String(text || ""));
    throw new Error(data?.error || (isHtml ? `接口不存在或服务未重启：POST ${url} (HTTP ${resp.status})` : text) || `HTTP ${resp.status}`);
  }
  return text ? JSON.parse(text) : null;
}

function showActionErrorModal(title, err) {
  const msg = `${title}失败：${err?.message || err || "未知错误"}`;
  alert(msg);
  log(msg);
}

function setButtonsDisabled(v) {
  document.querySelectorAll("button").forEach((b) => (b.disabled = !!v));
}

function showSuccessModal(msg) {
  return new Promise((resolve) => {
    $("successModalText").textContent = msg || "操作成功";
    $("successModal").classList.remove("hidden");
    $("successModalConfirmBtn").onclick = () => {
      $("successModal").classList.add("hidden");
      resolve();
    };
  });
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function resetOverlayProgress() {
  const wrap = $("actionProgressWrap");
  const fill = $("actionProgressFill");
  const detail = $("actionProgressDetail");
  if (fill) {
    fill.style.width = "0%";
    fill.style.marginLeft = "0";
    fill.classList.remove("action-progress-fill--indeterminate");
  }
  if (detail) detail.textContent = "";
  if (wrap) wrap.classList.add("hidden");
}

/** 确定进度：current/total，例如完成 3 章共 10 章则 current=3 */
function setOverlayProgress(current, total, detailLine) {
  const wrap = $("actionProgressWrap");
  const fill = $("actionProgressFill");
  const detail = $("actionProgressDetail");
  if (!wrap || !fill || !detail) return;
  wrap.classList.remove("hidden");
  fill.classList.remove("action-progress-fill--indeterminate");
  fill.style.marginLeft = "0";
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  fill.style.width = `${pct}%`;
  detail.textContent = detailLine || "";
}

/** 单章长任务：无细粒度百分比时用滑动条表示仍在处理 */
function setOverlayIndeterminate(detailLine) {
  const wrap = $("actionProgressWrap");
  const fill = $("actionProgressFill");
  const detail = $("actionProgressDetail");
  if (!wrap || !fill || !detail) return;
  wrap.classList.remove("hidden");
  fill.classList.add("action-progress-fill--indeterminate");
  fill.style.marginLeft = "0";
  detail.textContent = detailLine || "处理中，请稍候…";
}

function showLoadingOverlay(text) {
  const ov = $("actionOverlay");
  if (!ov) return;
  const t = $("actionOverlayText");
  if (t) t.textContent = text || "处理中...";
  resetOverlayProgress();
  ov.classList.remove("hidden");
}

function hideLoadingOverlay() {
  $("actionOverlay")?.classList.add("hidden");
  resetOverlayProgress();
}

function setAiChatModelLabel() {
  if (!el.aiChatModelLabel || !el.textModelSelect) return;
  const selected = el.textModelSelect.selectedOptions?.[0];
  const modelName = selected?.textContent || el.textModelSelect.value || "-";
  el.aiChatModelLabel.textContent = `当前文本模型：${modelName}`;
}

function ensureAiChatGreeting() {
  if (state.aiChatMessages.length) return;
  state.aiChatMessages.push({
    role: "assistant",
    content: "你好，我是 Xflow AI 助手。你可以问我拆解思路、提示词优化、分镜建议，或让我们一起改当前项目内容。",
  });
}

function appendAssistantMessageContent(container, text) {
  const src = String(text || "");
  if (!src) return;
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  const isSafeImageUrl = (url) => /^(https?:\/\/|\/)/i.test(url);
  while ((m = re.exec(src))) {
    const before = src.slice(last, m.index);
    if (before) container.appendChild(document.createTextNode(before));
    const alt = String(m[1] || "生成图片").trim() || "生成图片";
    const url = String(m[2] || "").trim();
    if (url && isSafeImageUrl(url)) {
      const br1 = document.createElement("br");
      container.appendChild(br1);
      const img = document.createElement("img");
      img.className = "ai-chat-inline-image";
      img.src = url;
      img.alt = alt;
      container.appendChild(img);
      const br2 = document.createElement("br");
      container.appendChild(br2);
    } else {
      container.appendChild(document.createTextNode(m[0]));
    }
    last = re.lastIndex;
  }
  const tail = src.slice(last);
  if (tail) container.appendChild(document.createTextNode(tail));
}

function renderAiChatMessages() {
  if (!el.aiChatMessages) return;
  el.aiChatMessages.innerHTML = "";
  if (!state.aiChatMessages.length) {
    const empty = document.createElement("div");
    empty.className = "ai-chat-empty";
    empty.textContent = "开始一段新的对话吧。";
    el.aiChatMessages.appendChild(empty);
    return;
  }

  state.aiChatMessages.forEach((m) => {
    const row = document.createElement("div");
    row.className = `ai-chat-msg ${m.role === "user" ? "ai-chat-msg-user" : "ai-chat-msg-assistant"}`;
    if (m.role === "assistant") appendAssistantMessageContent(row, m.content || "");
    else row.textContent = m.content || "";
    el.aiChatMessages.appendChild(row);
  });
  el.aiChatMessages.scrollTop = el.aiChatMessages.scrollHeight;
}

function openAiChatModal() {
  if (!el.aiChatModal) return;
  ensureAiChatGreeting();
  setAiChatModelLabel();
  renderAiChatMessages();
  el.aiChatModal.classList.remove("hidden");
  setTimeout(() => el.aiChatInput?.focus(), 0);
}

function closeAiChatModal() {
  el.aiChatModal?.classList.add("hidden");
}

const CHAT_IMAGE_WAIT_TEXT = "图片生成中，请稍候（复杂画面可能需要数分钟）…";

/** 与 server 端 parseChatImageCommand 显式生图写法对齐，用于在首包前显示等待文案 */
function isLikelyChatImageCommand(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (/^\/(?:img|image)\s+\S/i.test(s)) return true;
  if (/^(?:帮我)?(?:生成图片|生图|画图)\s*[：:]\s*\S/i.test(s)) return true;
  if (/^(?:帮我)?(?:生成|画)\s*(?:一张|1张)?\s*图\s*[：:]\s*\S/i.test(s)) return true;
  return false;
}

/** 与 server 端 parseProjectOutlineCommand 大致对齐，避免误勾生图模式时把「提取大纲」当成生图 */
function looksLikeProjectOutlineExtract(text) {
  return /提取\s*.+?\s*(?:第\s*)?(?:[0-9一二三四五六七八九十]+|第一|第二|第三|第四|第五|第六|第七|第八|第九|第十)\s*(?:章|集|回|话|节)\s*大纲/i.test(
    String(text || ""),
  );
}

async function sendAiChatMessage() {
  if (state.aiChatSending) return;
  const text = String(el.aiChatInput?.value || "").trim();
  if (!text) return;

  const history = state.aiChatMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  state.aiChatMessages.push({ role: "user", content: text });
  renderAiChatMessages();
  if (el.aiChatInput) el.aiChatInput.value = "";

  state.aiChatSending = true;
  if (el.sendAiChatBtn) {
    el.sendAiChatBtn.disabled = true;
    el.sendAiChatBtn.textContent = "发送中...";
  }
  try {
    // Stream assistant reply for faster perceived latency.
    const assistantMsg = { role: "assistant", content: "" };
    state.aiChatMessages.push(assistantMsg);
    renderAiChatMessages();
    const payload = {
      message: text,
      history,
      visualStyle: el.visualStyleInput?.value?.trim() || "",
      imageMode: Boolean(el.aiChatImageModeCheck?.checked),
    };
    const showImageWaitEarly =
      isLikelyChatImageCommand(text) || (payload.imageMode && !looksLikeProjectOutlineExtract(text));
    if (showImageWaitEarly) {
      assistantMsg.content = CHAT_IMAGE_WAIT_TEXT;
      assistantMsg._replaceNextImageDelta = true;
      renderAiChatMessages();
    }
    let streamOk = false;
    try {
      let resp;
      try {
        resp = await fetch("/api/settings/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify(payload),
          credentials: "include",
        });
      } catch (streamErr) {
        const online = typeof navigator !== "undefined" ? navigator.onLine : true;
        throw new Error(`流式请求失败(/api/settings/chat/stream)：${streamErr?.message || streamErr}（online=${online}）`);
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(errText || `HTTP ${resp.status}`);
      }
      if (!resp.body) throw new Error("浏览器不支持流式响应");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      const applyEvent = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (obj.type === "meta" && obj.modelId) {
          setAiChatModelLabel();
        }
        if (obj.type === "image_wait" && typeof obj.message === "string") {
          assistantMsg.content = obj.message;
          assistantMsg._replaceNextImageDelta = true;
          renderAiChatMessages();
          return;
        }
        if (obj.type === "delta" && typeof obj.delta === "string") {
          if (assistantMsg._replaceNextImageDelta) {
            assistantMsg.content = obj.delta;
            delete assistantMsg._replaceNextImageDelta;
          } else {
            assistantMsg.content += obj.delta;
          }
          renderAiChatMessages();
        }
        if (obj.type === "error") {
          throw new Error(obj.message || "流式返回错误");
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const b of blocks) {
          const m = String(b || "").match(/^data:\s*(.+)$/m);
          if (!m) continue;
          const chunk = (m[1] || "").trim();
          if (!chunk) continue;
          applyEvent(JSON.parse(chunk));
        }
      }

      if (!assistantMsg.content.trim()) assistantMsg.content = "（模型未返回可用内容）";
      renderAiChatMessages();
      streamOk = true;
    } catch {
      // Fallback for upstream/model without streaming support.
      if (showImageWaitEarly) {
        assistantMsg.content = CHAT_IMAGE_WAIT_TEXT;
        assistantMsg._replaceNextImageDelta = true;
        renderAiChatMessages();
      }
      const r = await postJson("/api/settings/chat", payload);
      const reply = String(r?.reply || "").trim() || "（模型未返回可用内容）";
      const mode = String(r?.mode || "");
      if (mode === "image") {
        assistantMsg.content = reply;
        delete assistantMsg._replaceNextImageDelta;
      } else {
        assistantMsg.content = `${reply}\n\n（提示：当前模型可能不支持流式输出，已自动切换为普通响应）`;
        delete assistantMsg._replaceNextImageDelta;
      }
      renderAiChatMessages();
      streamOk = true;
    }
    if (!streamOk) throw new Error("chat unavailable");
  } catch (e) {
    const errText = `请求失败：${e.message || "未知错误"}`;
    state.aiChatMessages.push({ role: "assistant", content: errText });
    renderAiChatMessages();
    log(`AI 对话 - 失败：${e.message}`);
  } finally {
    state.aiChatSending = false;
    if (el.sendAiChatBtn) {
      el.sendAiChatBtn.disabled = false;
      el.sendAiChatBtn.textContent = "发送";
    }
    el.aiChatInput?.focus();
  }
}

/** name, fn, successMsg?, { loadingText } */
async function withFeedback(name, fn, successMsg, options) {
  const loadingText = options?.loadingText;
  log(`${name} - 加载中...`);
  if (loadingText) showLoadingOverlay(loadingText);
  setButtonsDisabled(true);
  try {
    const r = await fn();
    log(`${name} - 完成`);
    setButtonsDisabled(false);
    if (loadingText) hideLoadingOverlay();
    if (successMsg) await showSuccessModal(successMsg);
    return r;
  } catch (e) {
    log(`${name} - 失败：${e.message}`);
    throw e;
  } finally {
    if (loadingText) hideLoadingOverlay();
    setButtonsDisabled(false);
  }
}

function isMobileLayout() {
  try {
    return window.matchMedia("(max-width: 900px)").matches;
  } catch {
    return window.innerWidth <= 900;
  }
}

function closeMobileSidebar() {
  el.sidebarNav?.classList.remove("is-open");
  el.sidebarBackdrop?.classList.remove("is-visible");
  if (el.sidebarMenuBtn) el.sidebarMenuBtn.setAttribute("aria-expanded", "false");
}

function toggleMobileSidebar() {
  if (!isMobileLayout()) return;
  const willOpen = !el.sidebarNav?.classList.contains("is-open");
  el.sidebarNav?.classList.toggle("is-open", willOpen);
  el.sidebarBackdrop?.classList.toggle("is-visible", willOpen);
  el.sidebarMenuBtn?.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function setActiveTab(tabName) {
  closeMobileSidebar();
  el.tabButtons.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.id === `tab-${tabName}`));
}

/** 去掉清单前的 Markdown 标题行，避免干扰解析 */
function stripMarkdownHeadings(md) {
  return String(md || "")
    .replace(/^#{1,6}\s*[^\n]*\n*/gm, "")
    .trim();
}

function normalizeAnalyzerTitleKey(t) {
  return String(t || "")
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/`/g, "")
    .trim();
}

/** 禁止作为「人物卡片标题」的 **…** 内容（技能模板字段/章节说明，勿拆成独立人物） */
const CHARACTER_TITLE_DENY = new Set(
  [
    "身份",
    "外貌描述",
    "AI生图提示词",
    "AI生图提示词(Prompt)",
    "语言要求",
    "必含元素",
    "示例",
    "搜索关键词",
    "核心发现",
    "视觉基调",
    "色调建议",
    "镜头语言",
    "场景类型",
    "环境描述",
    "人物清单",
    "场景清单",
    "总结",
    "人物与场景关系图",
    "关键设定检索结果",
    "项目名",
    "类型/题材",
    "类型",
    "题材",
    "核心冲突",
    "目标观感",
    "视觉风格偏好",
  ].map(normalizeAnalyzerTitleKey)
);

/** 禁止作为「场景卡片标题」的 **…** 内容 */
const SCENE_TITLE_DENY = new Set(
  [
    "场景类型",
    "环境描述",
    "身份",
    "外貌描述",
    "AI生图提示词",
    "AI生图提示词(Prompt)",
    "语言要求",
    "必含元素",
    "示例",
    "搜索关键词",
    "核心发现",
    "视觉基调",
    "人物清单",
    "场景清单",
  ].map(normalizeAnalyzerTitleKey)
);

function isDeniedCharacterTitle(title) {
  const k = normalizeAnalyzerTitleKey(title);
  if (!k) return true;
  if (CHARACTER_TITLE_DENY.has(k)) return true;
  if (k.includes("AI生图提示词") && k.length < 28) return true;
  return false;
}

function isDeniedSceneTitle(title) {
  const k = normalizeAnalyzerTitleKey(title);
  if (!k) return true;
  if (SCENE_TITLE_DENY.has(k)) return true;
  if (k.includes("AI生图提示词") && k.length < 28) return true;
  return false;
}

/**
 * script-analyzer：每人/每场景仅允许顶级 `- **名称**`；正文为技能要求的嵌套字段（身份/外貌/提示词 或 场景类型/环境/提示词）。
 * 丢弃：模板字段误作顶级 **标题**、以及无 ** 的顶级杂项行（避免「凡是名字就占一格」）。
 */
function parseAnalyzerCards(md, kind) {
  const deny = kind === "scene" ? isDeniedSceneTitle : isDeniedCharacterTitle;
  const text = stripMarkdownHeadings(md);
  if (!text) return [];
  const lines = text.split("\n");
  const result = [];
  let cur = null;
  let idx = 1;
  let skipPlainTop = false;

  for (const lineRaw of lines) {
    const leading = lineRaw.length - lineRaw.trimStart().length;
    const isTopBullet = leading === 0 && /^\s*-\s+/.test(lineRaw);

    if (skipPlainTop) {
      if (isTopBullet && /^-\s+\*\*(.+?)\*\*/.test(lineRaw)) {
        skipPlainTop = false;
      } else {
        continue;
      }
    }

    if (isTopBullet && /^-\s+\*\*(.+?)\*\*/.test(lineRaw)) {
      const m = lineRaw.match(/^-\s+\*\*(.+?)\*\*/);
      const title = (m[1] || "").trim();
      if (deny(title)) {
        if (cur) {
          result.push(cur);
          cur = null;
        }
        skipPlainTop = true;
        continue;
      }
      if (cur) result.push(cur);
      cur = { id: `e_${idx++}`, title, content: "" };
      const after = lineRaw.slice(m[0].length).trim();
      if (after) cur.content = after;
      continue;
    }

    if (isTopBullet && !/^-\s+\*\*/.test(lineRaw)) {
      if (cur) {
        result.push(cur);
        cur = null;
      }
      skipPlainTop = true;
      continue;
    }

    if (!cur) continue;
    cur.content += (cur.content ? "\n" : "") + lineRaw;
  }

  if (cur) result.push(cur);
  if (result.length === 0 && text.trim()) {
    return [{ id: "e_1", title: "（未解析到规范条目，请重新提取大纲或按技能格式编辑）", content: text }];
  }
  return result;
}

/** 顶级 `- 物品：名称` 一条道具一块，提示词等写在同一块正文 */
function parseTopLevelItemBlocks(md) {
  const text = stripMarkdownHeadings(md);
  if (!text) return [];
  const lines = text.split("\n");
  const result = [];
  let cur = null;
  let idx = 1;
  for (const lineRaw of lines) {
    const trimmed = lineRaw.trim();
    if (!trimmed && !cur) continue;
    const leading = lineRaw.length - lineRaw.trimStart().length;
    const isTop = leading === 0 && /^-\s*物品：/.test(lineRaw);
    if (isTop) {
      const m = lineRaw.match(/^-\s*物品：(.+)$/);
      if (cur) result.push(cur);
      cur = { id: `e_${idx++}`, title: (m[1] || "").trim(), content: "" };
      continue;
    }
    if (!cur) {
      if (trimmed) cur = { id: `e_${idx++}`, title: "物品", content: lineRaw };
      continue;
    }
    cur.content += (cur.content ? "\n" : "") + lineRaw;
  }
  if (cur) result.push(cur);
  if (result.length === 0 && text.trim()) return [{ id: "e_1", title: "内容", content: text }];
  return result;
}

/** 服务端写入的 characterCards / sceneCards，避免再解析 Markdown */
function cardsFromStoredCardArray(arr, prefix) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((x, i) => ({
    id: String(x.id || `${prefix}_${i + 1}`),
    title: String(x.title || "").trim() || `${prefix}${i + 1}`,
    content: String(x.content || "").trim(),
  }));
}

function parseOutlineToModules(outline) {
  const fromCh = cardsFromStoredCardArray(outline.characterCards, "ch");
  const fromSc = cardsFromStoredCardArray(outline.sceneCards, "sc");
  return {
    characters: fromCh ?? parseAnalyzerCards(outline.charactersMd, "character"),
    scenes: fromSc ?? parseAnalyzerCards(outline.scenesMd, "scene"),
    items: parseTopLevelItemBlocks(outline.itemsMd),
    storyline: [{ id: "story_1", title: "故事线", content: outline.storylineMd || "" }],
  };
}

function parseAssetsToModules(assets) {
  const fromCh = cardsFromStoredCardArray(assets.characterCards, "ach");
  const fromSc = cardsFromStoredCardArray(assets.sceneCards, "asc");
  const fromIt = cardsFromStoredCardArray(assets.itemCards, "ait");
  const chCards = withAssetImageBinding(fromCh ?? parseAnalyzerCards(assets.charactersMd, "character"), assets, "characters");
  const scCards = withAssetImageBinding(fromSc ?? parseAnalyzerCards(assets.scenesMd, "scene"), assets, "scenes");
  const itCards = withAssetImageBinding(fromIt ?? parseTopLevelItemBlocks(assets.itemsMd), assets, "items");
  return {
    characters: chCards,
    scenes: scCards,
    items: itCards,
    storyboard: [{ id: "sb_1", title: "分镜脚本", content: assets.storyboardMd || "" }],
    storyboardPrompts: [{ id: "sp_1", title: "分镜提示词", content: assets.storyboardPromptsMd || "" }],
    chapterText: [{ id: "ct_1", title: "章节文本", content: assets.chapterText || "" }],
  };
}

function modulesToOutline(mods) {
  const joinCards = (cards, titleFmt) =>
    cards.map((c) => `- ${titleFmt(c.title)}\n${(c.content || "").trim()}`).join("\n");
  return {
    charactersMd: joinCards(mods.characters, (t) => `**${t}**`),
    scenesMd: joinCards(mods.scenes, (t) => `**${t}**`),
    characterCards: mods.characters.map((c) => ({
      title: c.title,
      content: (c.content || "").trim(),
    })),
    sceneCards: mods.scenes.map((c) => ({
      title: c.title,
      content: (c.content || "").trim(),
    })),
    itemsMd: joinCards(mods.items, (t) => `物品：${t}`),
    storylineMd: (mods.storyline[0]?.content || "").trim(),
  };
}

function modulesToAssets(mods) {
  const joinCards = (cards, titleFmt) =>
    cards.map((c) => `- ${titleFmt(c.title)}\n${(c.content || "").trim()}`).join("\n");
  return {
    charactersMd: joinCards(mods.characters, (t) => `**${t}**`),
    scenesMd: joinCards(mods.scenes, (t) => `**${t}**`),
    characterCards: mods.characters.map((c) => ({
      id: c.id,
      title: c.title,
      content: (c.content || "").trim(),
    })),
    sceneCards: mods.scenes.map((c) => ({
      id: c.id,
      title: c.title,
      content: (c.content || "").trim(),
    })),
    itemsMd: joinCards(mods.items, (t) => `物品：${t}`),
    itemCards: mods.items.map((c) => ({
      id: c.id,
      title: c.title,
      content: (c.content || "").trim(),
    })),
    storyboardMd: (mods.storyboard[0]?.content || "").trim(),
    storyboardPromptsMd: (mods.storyboardPrompts[0]?.content || "").trim(),
    chapterText: (mods.chapterText[0]?.content || "").trim(),
  };
}

/** 切换/新建项目时立即清空界面与内存状态，避免仍显示上一项目内容 */
function resetWorkspaceUIState() {
  state.loadedOutline = null;
  state.loadedAssets = null;
  state.selectedChapterIds.clear();
  state.workspace.chapters = [];
  state.outlineCardsByModule = { characters: [], scenes: [], items: [], storyline: [] };
  state.assetCardsByModule = {
    characters: [],
    scenes: [],
    items: [],
    storyboard: [],
    storyboardPrompts: [],
    chapterText: [],
  };
  state.outlineModule = "characters";
  state.assetModule = "characters";
  el.novelTextInput.value = "";
  el.outlineCards.innerHTML = "";
  el.assetCards.innerHTML = "";
  el.outlineModuleTitle.textContent = "人物";
  el.assetModuleTitle.textContent = "人物";
  highlightModuleButtons("data-mod", state.outlineModule);
  highlightModuleButtons("data-amod", state.assetModule);
  el.chapterCheckboxList.innerHTML = "";
  el.outlineChapterSelect.innerHTML = "";
  el.assetsChapterSelect.innerHTML = "";
}

function renderProjectList() {
  el.projectList.innerHTML = "";
  if (!state.projects.length) {
    el.projectList.innerHTML = `<div style="color:#a8c6ff;font-size:12px;padding:10px;">暂无项目，请创建。</div>`;
    return;
  }
  state.projects.forEach((p) => {
    const d = document.createElement("div");
    d.className = `project-item ${state.currentProjectId === p.id ? "is-active" : ""}`;
    d.innerHTML = `<div class="project-item-row">
      <div class="project-item-main">
        <div class="name">${p.name}</div>
        <div class="meta">${p.visualStyle || ""}</div>
      </div>
      <button type="button" class="project-delete-btn" title="删除项目">✕</button>
    </div>`;
    d.querySelector(".project-item-main").onclick = () => selectProject(p.id);
    const del = d.querySelector(".project-delete-btn");
    del.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteProject(p.id, p.name);
    };
    el.projectList.appendChild(d);
  });
}

async function deleteProject(projectId, projectName) {
  const label = projectName || projectId;
  if (!confirm(`确定删除项目「${label}」？\n所有章节、大纲与资产将永久删除，不可恢复。`)) return;
  await withFeedback("删除项目", async () => {
    await postJson(`/api/projects/${projectId}/delete`, { confirmToken: "DELETE_OK" });
    const list = await getJson("/api/projects/list");
    state.projects = list.projects || [];
    const wasCurrent = state.currentProjectId === projectId;
    if (wasCurrent) {
      state.currentProjectId = null;
      resetWorkspaceUIState();
      el.projectNameLabel.textContent = "未选择项目";
    }
    renderProjectList();
    if (state.projects.length) {
      if (wasCurrent) await selectProject(state.projects[0].id);
    } else {
      log("暂无项目，请创建。");
    }
  }, "项目已删除");
}

async function deleteChapter(chapterId) {
  if (!confirm("确定删除该章节？关联的大纲和资产数据也会被删除。")) return;
  await withFeedback("删除章节", async () => {
    await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/delete-chapter`, {});
    await refreshWorkspace();
  });
}

function renderChapterChecklist() {
  el.chapterCheckboxList.innerHTML = "";
  state.selectedChapterIds.clear();
  lastCheckedChapterIdx = -1;

  // Apply / remove grid layout class
  if (chapterCompactMode) {
    el.chapterCheckboxList.classList.add("is-grid");
  } else {
    el.chapterCheckboxList.classList.remove("is-grid");
  }

  if (!state.workspace.chapters.length) {
    el.chapterCheckboxList.innerHTML = `<div style="color:#a8c6ff;font-size:12px;">暂无章节，请先拆解。</div>`;
    return;
  }

  const chapters = state.workspace.chapters;
  chapters.forEach((c, idx) => {
    const row = document.createElement("label");
    const outlineDot = c.hasOutline ? `<span class="chapter-outline-dot" title="已提取大纲"></span>` : "";

    if (chapterCompactMode) {
      row.className = "chapter-item is-compact";
      row.innerHTML = `<input type="checkbox" value="${c.id}" />
        <div class="title">${c.order}. ${c.title}${outlineDot}</div>
        <button class="delete-btn" title="删除章节">✕</button>`;
    } else {
      row.className = "chapter-item";
      row.innerHTML = `<input type="checkbox" value="${c.id}" />
        <div style="flex:1;min-width:0;">
          <div class="title">${c.order}. ${c.title}${outlineDot}</div>
          <div class="content-snippet">${(c.content || "").slice(0, 120)}</div>
        </div>
        <button class="delete-btn" title="删除章节">✕</button>`;
    }

    const ck = row.querySelector("input");

    // Whole-card click handler (handles shift+click range selection)
    row.onclick = (e) => {
      // Prevent double-trigger from the native label→checkbox link
      if (e.target.tagName === "BUTTON") return;
      e.preventDefault();

      const newChecked = !ck.checked;
      if (e.shiftKey && lastCheckedChapterIdx !== -1) {
        // Range select: toggle all chapters between lastCheckedChapterIdx and idx
        const lo = Math.min(lastCheckedChapterIdx, idx);
        const hi = Math.max(lastCheckedChapterIdx, idx);
        const items = el.chapterCheckboxList.querySelectorAll(".chapter-item");
        for (let i = lo; i <= hi; i++) {
          const item = items[i];
          const itemCk = item.querySelector("input[type=checkbox]");
          itemCk.checked = newChecked;
          item.classList.toggle("is-checked", newChecked);
          if (newChecked) {
            state.selectedChapterIds.add(itemCk.value);
          } else {
            state.selectedChapterIds.delete(itemCk.value);
          }
        }
      } else {
        ck.checked = newChecked;
        row.classList.toggle("is-checked", newChecked);
        if (newChecked) {
          state.selectedChapterIds.add(c.id);
        } else {
          state.selectedChapterIds.delete(c.id);
        }
      }
      lastCheckedChapterIdx = idx;
    };

    const delBtn = row.querySelector(".delete-btn");
    delBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteChapter(c.id);
    };

    el.chapterCheckboxList.appendChild(row);
  });
}

function fillChapterSelect(selectEl, useOutlineFlag) {
  selectEl.innerHTML = "";
  state.workspace.chapters.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id;
    const flag = useOutlineFlag
      ? c.hasOutline ? "（已拆解）" : "（未拆解）"
      : c.hasAssets ? "（已生成）" : "（未生成）";
    o.textContent = `${c.order}. ${c.title}${flag}`;
    selectEl.appendChild(o);
  });
}

function currentOutlineCards() {
  return state.outlineCardsByModule[state.outlineModule] || [];
}

function currentAssetCards() {
  return state.assetCardsByModule[state.assetModule] || [];
}

function stableHash(input) {
  const s = String(input || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function normalizeAssetEntryId(moduleType, card, index) {
  const exist = String(card?.id || "").trim();
  if (exist) return exist;
  const title = String(card?.title || "").trim() || `entry_${index + 1}`;
  return `${moduleType}_${stableHash(`${moduleType}|${title}|${index}`)}`;
}

function normalizeAssetTitleKey(title) {
  return `title:${String(title || "").trim().toLowerCase()}`;
}

function getAssetCardImages(assets, moduleType, entryId, title) {
  const store = assets?.generatedImages?.[moduleType];
  if (!store || typeof store !== "object") return [];
  const byId = Array.isArray(store[entryId]) ? store[entryId] : [];
  const byTitle = Array.isArray(store[normalizeAssetTitleKey(title)]) ? store[normalizeAssetTitleKey(title)] : [];
  const merged = [...byId, ...byTitle];
  const seen = new Set();
  return merged.filter((x) => {
    const key = String(x?.url || x?.remoteUrl || "") + String(x?.createdAt || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withAssetImageBinding(cards, assets, moduleType) {
  return (cards || []).map((c, i) => {
    const id = normalizeAssetEntryId(moduleType, c, i);
    const images = getAssetCardImages(assets, moduleType, id, c.title);
    return { ...c, id, images };
  });
}

function extractAssetImagePrompt(content, title) {
  const text = String(content || "").replace(/\r\n/g, "\n").trim();
  if (!text) return String(title || "").trim();
  const lines = text.split("\n");

  const markerList = [/AI生图提示词\s*(?:\(Prompt\))?\s*[：:]/i, /提示词\s*(?:\(Prompt\))?\s*[：:]/i];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = markerList.find((re) => re.test(line));
    if (!marker) continue;
    const first = line.replace(marker, "").trim();
    const chunks = [];
    if (first) chunks.push(first);
    for (let j = i + 1; j < lines.length; j += 1) {
      const ln = lines[j];
      if (/^\s*-\s*\*\*[^*]+?\*\*\s*[：:]/.test(ln) || /^\s*\*\*[^*]+?\*\*\s*[：:]/.test(ln)) break;
      if (/^\s*-\s+\S/.test(ln) && !/^\s{2,}/.test(ln)) break;
      if (ln.trim()) chunks.push(ln.trim());
    }
    const merged = chunks.join(" ").replace(/\s+/g, " ").trim();
    if (merged) return merged;
  }

  const plain = text
    .replace(/^\s*-\s*\*\*[^*]+?\*\*\s*[：:]\s*/gm, "")
    .replace(/^\s*\*\*[^*]+?\*\*\s*[：:]\s*/gm, "")
    .replace(/^\s*-\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain || String(title || "").trim();
}

async function generateAssetImageForCard(card, moduleType) {
  const chapterId = el.assetsChapterSelect.value;
  if (!state.currentProjectId) throw new Error("请先选择项目");
  if (!chapterId) throw new Error("请先选择章节");

  const prompt = extractAssetImagePrompt(card.content, card.title);
  if (!prompt) throw new Error("该条目暂无可用提示词");

  const resp = await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/assets/generate-image`, {
    moduleType,
    entryId: card.id,
    title: card.title,
    prompt,
  });

  const image = resp?.image || null;
  const images = Array.isArray(resp?.images) ? resp.images : image ? [image] : [];
  card.images = images;

  const loaded = state.loadedAssets && typeof state.loadedAssets === "object" ? state.loadedAssets : {};
  const generatedImages = loaded.generatedImages && typeof loaded.generatedImages === "object" ? loaded.generatedImages : {};
  generatedImages[moduleType] = generatedImages[moduleType] && typeof generatedImages[moduleType] === "object" ? generatedImages[moduleType] : {};
  generatedImages[moduleType][card.id] = images;
  if (resp?.titleKey) generatedImages[moduleType][resp.titleKey] = images;
  loaded.generatedImages = generatedImages;
  state.loadedAssets = loaded;

  if (resp?.reused) {
    log(`「${card.title || "该条目"}」已复用项目资产库中的图片（跨章节复用，未重新生成）`);
  } else {
    log(`已生成「${card.title || "该条目"}」图片`);
  }
}

function renderCards(container, cards, selectable, options = {}) {
  const moduleType = options.moduleType || "";
  container.innerHTML = "";
  if (!cards.length) {
    container.innerHTML = `<div style="color:#a8c6ff;">暂无内容</div>`;
    return;
  }
  cards.forEach((c) => {
    const card = document.createElement("div");
    card.className = "entity-card";
    card.innerHTML = `
      <div class="entity-head">
        ${selectable ? `<input type="checkbox" class="entity-check" ${c.selected ? "checked" : ""}/>` : ""}
        <input class="entity-title" value="${(c.title || "").replace(/"/g, "&quot;")}" />
        <button class="delete-card-btn" title="删除此条目">✕</button>
      </div>
      <textarea class="entity-content" rows="6">${c.content || ""}</textarea>
    `;
    const titleEl = card.querySelector(".entity-title");
    const contentEl = card.querySelector(".entity-content");
    const checkEl = card.querySelector(".entity-check");
    const delEl = card.querySelector(".delete-card-btn");
    titleEl.oninput = () => (c.title = titleEl.value);
    contentEl.oninput = () => (c.content = contentEl.value);
    if (checkEl) checkEl.onchange = () => (c.selected = !!checkEl.checked);
    delEl.onclick = () => {
      if (!confirm(`确定删除「${c.title || "该条目"}」？`)) return;
      const i = cards.indexOf(c);
      if (i >= 0) cards.splice(i, 1);
      renderCards(container, cards, selectable, options);
    };

    if (selectable && ["characters", "scenes", "items"].includes(moduleType)) {
      const tools = document.createElement("div");
      tools.className = "entity-image-tools";

      const genBtn = document.createElement("button");
      genBtn.type = "button";
      genBtn.className = "entity-gen-image-btn";
      genBtn.textContent = c._imageGenerating ? "生成中..." : "按提示词生成图片";
      genBtn.disabled = !!c._imageGenerating;
      genBtn.onclick = async () => {
        if (c._imageGenerating) return;
        c._imageGenerating = true;
        renderAssetModule();
        try {
          await generateAssetImageForCard(c, moduleType);
        } catch (err) {
          log(`生成图片失败：${err?.message || err || "未知错误"}`);
        } finally {
          c._imageGenerating = false;
          renderAssetModule();
        }
      };
      tools.appendChild(genBtn);

      const latest = Array.isArray(c.images) && c.images.length > 0 ? c.images[0] : null;
      if (latest?.url) {
        const openLink = document.createElement("a");
        openLink.href = latest.url;
        openLink.target = "_blank";
        openLink.rel = "noopener noreferrer";
        openLink.className = "entity-image-open-link";
        openLink.textContent = "查看大图";
        tools.appendChild(openLink);
      }
      card.appendChild(tools);

      const previewWrap = document.createElement("div");
      previewWrap.className = "entity-image-preview-wrap";
      if (latest?.url) {
        const img = document.createElement("img");
        img.className = "entity-image-preview";
        img.src = latest.url;
        img.alt = `${c.title || "资产"}图片`;
        previewWrap.appendChild(img);

        const meta = document.createElement("div");
        meta.className = "entity-image-meta";
        const when = latest.createdAt ? new Date(latest.createdAt).toLocaleString("zh-CN") : "";
        meta.textContent = when ? `最近生成：${when}` : "最近生成：刚刚";
        previewWrap.appendChild(meta);
      } else {
        const empty = document.createElement("div");
        empty.className = "entity-image-empty";
        empty.textContent = "暂无图片，可按当前提示词生成。";
        previewWrap.appendChild(empty);
      }
      card.appendChild(previewWrap);
    }

    container.appendChild(card);
  });
}

function highlightModuleButtons(attrName, activeValue) {
  document.querySelectorAll(`[${attrName}]`).forEach((b) =>
    b.classList.toggle("is-active", b.getAttribute(attrName) === activeValue)
  );
}

function renderOutlineModule() {
  const mapTitle = { characters: "人物", scenes: "场景", items: "物品", storyline: "故事线" };
  el.outlineModuleTitle.textContent = mapTitle[state.outlineModule];
  highlightModuleButtons("data-mod", state.outlineModule);
  renderCards(el.outlineCards, currentOutlineCards(), false);
}

function renderAssetModule() {
  const mapTitle = {
    characters: "人物",
    scenes: "场景",
    items: "物品",
    storyboard: "分镜脚本",
    storyboardPrompts: "分镜提示词",
    chapterText: "章节文本",
  };
  el.assetModuleTitle.textContent = mapTitle[state.assetModule];
  highlightModuleButtons("data-amod", state.assetModule);
  renderCards(el.assetCards, currentAssetCards(), ["characters", "scenes", "items"].includes(state.assetModule), {
    moduleType: state.assetModule,
  });
}

function bindModuleButtons() {
  document.querySelectorAll("[data-mod]").forEach((btn) => {
    btn.onclick = () => {
      state.outlineModule = btn.dataset.mod;
      renderOutlineModule();
    };
  });
  document.querySelectorAll("[data-amod]").forEach((btn) => {
    btn.onclick = () => {
      state.assetModule = btn.dataset.amod;
      renderAssetModule();
    };
  });
}

async function refreshWorkspace() {
  if (!state.currentProjectId) return;
  const data = await getJson(`/api/projects/${state.currentProjectId}/workspace`);
  state.workspace.chapters = data.chapters || [];
  el.visualStyleInput.value = data.settings.visualStyle || el.visualStyleInput.value;
  renderChapterChecklist();
  fillChapterSelect(el.outlineChapterSelect, true);
  fillChapterSelect(el.assetsChapterSelect, false);
}

async function selectProject(projectId) {
  resetWorkspaceUIState();
  state.currentProjectId = projectId;
  renderProjectList();
  el.projectNameLabel.textContent = "加载中...";
  const data = await getJson(`/api/projects/${projectId}/workspace`);
  el.projectNameLabel.textContent = data.settings.name;
  state.workspace.chapters = data.chapters || [];
  el.visualStyleInput.value = data.settings.visualStyle || el.visualStyleInput.value;
  renderChapterChecklist();
  fillChapterSelect(el.outlineChapterSelect, true);
  fillChapterSelect(el.assetsChapterSelect, false);
  log(`已切换项目：${data.settings.name}`);
}

async function loadModels() {
  const data = await getJson("/api/settings/models");
  const textOptions = data.textOptions || data.options || [];
  const selectedTextModelId = data.selectedTextModelId || data.selectedModelId || "";
  const imageOptions = data.imageOptions || [
    { modelId: "nano-banana2", modelName: "Nano banana2（最强画质·推荐）" },
    { modelId: "gpt-image-2", modelName: "GPT Image 2" },
  ];
  const ratioOptions = data.imageAspectRatioOptions || ["1:1", "16:9", "9:16"];
  const selectedImageModelId = data.selectedImageModelId || "nano-banana2";
  const selectedImageAspectRatio = data.selectedImageAspectRatio || "16:9";

  if (el.textModelSelect) el.textModelSelect.innerHTML = "";
  textOptions.forEach((m) => {
    const o = document.createElement("option");
    o.value = m.modelId;
    const hint = String(m.hint || "").trim();
    o.textContent = hint ? `${m.modelName}（${hint}）` : m.modelName;
    o.title = hint ? `${m.modelName}：${hint}` : m.modelName;
    if (m.modelId === selectedTextModelId) o.selected = true;
    el.textModelSelect?.appendChild(o);
  });

  if (el.imageModelSelect) el.imageModelSelect.innerHTML = "";
  imageOptions.forEach((m) => {
    const o = document.createElement("option");
    o.value = m.modelId;
    o.textContent = m.modelName;
    if (m.modelId === selectedImageModelId) o.selected = true;
    el.imageModelSelect?.appendChild(o);
  });

  if (el.imageAspectRatioSelect) el.imageAspectRatioSelect.innerHTML = "";
  ratioOptions.forEach((ratio) => {
    const o = document.createElement("option");
    o.value = ratio;
    o.textContent = ratio;
    if (ratio === selectedImageAspectRatio) o.selected = true;
    el.imageAspectRatioSelect?.appendChild(o);
  });
  setAiChatModelLabel();
}

async function loadBilling() {
  const d = await getJson("/api/settings/billing");
  const b = d?.billing || {};
  state.billing = b;
  const u = b.tokenUsage || {};
  el.pointsBalanceText.textContent = formatInt(b.pointsBalance);
  el.pointsSpentText.textContent = formatInt(b.pointsSpent);
  el.tokenUsageText.textContent = formatInt(u.total || 0);
  const lu = b.lastUsage;
  if (!lu) {
    el.lastUsageText.textContent = "暂无调用记录";
  } else {
    if (lu.type === "image_usage") {
      el.lastUsageText.textContent = [
        `类型：图片生成`,
        `图片模型：${lu.imageModelId || "-"}`,
        `比例：${lu.aspectRatio || "-"}`,
        `扣减积分：${formatInt(lu.pointsCost || 0)}`,
        `时间：${formatTime(lu.at || b.billingUpdatedAt)}`,
      ].join("\n");
    } else {
      el.lastUsageText.textContent = [
        `模型：${lu.modelId || "-"}`,
        `Token：${formatInt(lu.totalTokens || 0)}（输入 ${formatInt(lu.promptTokens || 0)} / 输出 ${formatInt(lu.completionTokens || 0)}）`,
        `扣减积分：${formatInt(lu.pointsCost || 0)}`,
        `时间：${formatTime(lu.at || b.billingUpdatedAt)}`,
      ].join("\n");
    }
  }

  if (el.billingWarnText) {
    if (b.isLowBalance) {
      el.billingWarnText.classList.remove("hidden");
      el.billingWarnText.textContent = `积分偏低（当前 ${formatInt(b.pointsBalance)}），建议尽快充值或切换更省 token 的模型。`;
    } else {
      el.billingWarnText.classList.add("hidden");
      el.billingWarnText.textContent = "";
    }
  }

  const logsResp = await getJson("/api/settings/billing/logs?page=1&pageSize=8").catch(() => null);
  const logs = Array.isArray(logsResp?.logs) ? logsResp.logs : [];
  if (!logs.length) {
    el.billingLogsText.textContent = "暂无账单记录";
  } else {
    el.billingLogsText.textContent = logs
      .map((x) => {
        const at = formatTime(x.at);
        if (x.type === "recharge" || x.type === "recharge_alipay" || x.type === "recharge_aggregate" || x.type === "recharge_aggregate_sync") {
          return `【充值】+${formatInt(x.pointsAdded || 0)} 积分 (${at})`;
        }
        if (x.type === "admin_adjust") {
          const delta = Number(x.delta || 0);
          const sign = delta >= 0 ? "+" : "";
          return `【管理员调整】${sign}${formatInt(delta)} 积分 (${at})`;
        }
        if (x.type === "image_usage") {
          const model = x.imageModelId || "图片模型";
          const ratio = x.aspectRatio ? ` / ${x.aspectRatio}` : "";
          return `【图片生成】-${formatInt(x.pointsCost || 0)} 积分 / ${model}${ratio} (${at})`;
        }
        return `【调用】-${formatInt(x.pointsCost || 0)} 积分 / ${formatInt(x.totalTokens || 0)} token / ${x.modelId || "-"} (${at})`;
      })
      .join("\n");
  }
}

async function warnLowBalanceBeforeRun(actionLabel) {
  await loadBilling().catch(() => null);
  const b = state.billing || {};
  if (!b.isLowBalance) return true;
  const balance = formatInt(b.pointsBalance || 0);
  return confirm(`${actionLabel}\n当前积分较低（${balance}），继续执行可能中途失败。是否继续？`);
}

function setAdminEntryVisible(show) {
  const fn = show ? "remove" : "add";
  el.adminEntryLink?.classList[fn]("hidden");
  el.adminSettingsLink?.classList[fn]("hidden");
  el.adminTopbarLink?.classList[fn]("hidden");
}

function applyAdminVisibilityFromMe(me) {
  setAdminEntryVisible(Boolean(me?.user?.isAdmin));
}

async function refreshAdminEntryVisibility() {
  try {
    const me = await getJson("/api/auth/me");
    applyAdminVisibilityFromMe(me);
  } catch {
    setAdminEntryVisible(false);
  }
}

async function loadCustomTextModel() {
  if (!el.customTextEnable) return;
  const d = await getJson("/api/settings/custom-text-model").catch(() => null);
  if (!d) return;
  el.customTextEnable.checked = Boolean(d.enabled);
  if (el.customTextProvider) el.customTextProvider.value = String(d.provider || "oioiapi");
  if (el.customTextBaseUrl) el.customTextBaseUrl.value = String(d.baseUrl || "https://oioiapi.site/v1");
  el.customTextModelName.value = d.modelName || "";
  el.customTextApiKey.value = ""; // never prefill key
  const st = el.customTextKeyStatus;
  if (st) {
    if (d.hasApiKey) {
      st.textContent = `已保存 Key：${d.apiKeyMasked}`;
      st.className = "custom-text-key-status has-key";
    } else {
      st.textContent = "尚未配置 API Key";
      st.className = "custom-text-key-status";
    }
  }
}

async function init() {
  log(`前端已加载 build=${APP_BUILD}`);
  const me = await getJson("/api/auth/me").catch(() => null);
  if (!me?.user) {
    window.location.href = "/login.html";
    return;
  }
  el.mePhone.textContent = me.user.phone || "-";
  applyAdminVisibilityFromMe(me);
  await loadModels();
  await loadCustomTextModel().catch(() => null);
  await loadBilling().catch(() => null);
  const list = await getJson("/api/projects/list");
  state.projects = list.projects || [];
  renderProjectList();
  if (state.projects.length) await selectProject(state.projects[0].id);
  else log("暂无项目，请创建。");
}

/* ---- Event handlers ---- */

el.createProjectBtn.onclick = async () => {
  const name = prompt("项目名称", "我的短剧项目");
  if (!name) return;
  await withFeedback("创建项目", async () => {
    const d = await postJson("/api/projects/create", { name, visualStyle: el.visualStyleInput.value.trim() });
    const list = await getJson("/api/projects/list");
    state.projects = list.projects || [];
    renderProjectList();
    await selectProject(d.project.id);
    setActiveTab("novel");
  });
};

el.saveVisualStyleBtn.onclick = async () => {
  if (!state.currentProjectId) return log("请先选择项目");
  const visualStyle = el.visualStyleInput.value.trim();
  if (!visualStyle) return log("请先输入视觉风格");
  await withFeedback("保存视觉风格", async () => {
    await postJson(`/api/projects/${state.currentProjectId}/save-visual-style`, { visualStyle });
    const list = await getJson("/api/projects/list");
    state.projects = list.projects || [];
    renderProjectList();
  }, "视觉风格已保存");
};

el.settingsNavBtn.onclick = () => {
  closeMobileSidebar();
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("is-active"));
  $("tab-settings").classList.add("is-active");
  refreshAdminEntryVisibility().catch(() => {});
  loadBilling().catch(() => null);
};
el.closeSettingsBtn.onclick = () => setActiveTab("novel");

el.saveModelBtn.onclick = async () =>
  withFeedback("保存模型设置", async () => {
    await postJson("/api/settings/model", {
      textModelId: el.textModelSelect?.value,
      imageModelId: el.imageModelSelect?.value,
      imageAspectRatio: el.imageAspectRatioSelect?.value,
    });
    setAiChatModelLabel();
  }, "模型设置已保存");

el.refreshBillingBtn.onclick = async () =>
  withFeedback(
    "刷新账单",
    async () => {
      await loadBilling();
    },
    "账单信息已更新"
  );

if (el.saveCustomTextBtn) {
  el.saveCustomTextBtn.onclick = async () => {
    try {
      await withFeedback("保存自定义通道", async () => {
        const enabled   = Boolean(el.customTextEnable?.checked);
        const modelName = String(el.customTextModelName?.value || "").trim();
        const apiKey    = String(el.customTextApiKey?.value || "").trim();
        const body = { enabled, modelName };
        if (apiKey) body.apiKey = apiKey;
        await postJson("/api/settings/custom-text-model", body);
        el.customTextApiKey.value = "";
        await loadCustomTextModel();
        await loadModels();
        setAiChatModelLabel();
      }, "自定义通道已保存");
    } catch (err) {
      showActionErrorModal("保存自定义通道", err);
    }
  };
}

if (el.clearCustomTextBtn) {
  el.clearCustomTextBtn.onclick = async () => {
    if (!confirm("确认清空自定义通道配置？已保存的 API Key 将被删除，且不可恢复。")) return;
    try {
      await withFeedback("清空自定义通道", async () => {
        await postJson("/api/settings/custom-text-model", { clearApiKey: true, enabled: false });
        el.customTextModelName.value = "";
        el.customTextApiKey.value = "";
        if (el.customTextEnable) el.customTextEnable.checked = false;
        await loadCustomTextModel();
        await loadModels();
        setAiChatModelLabel();
      }, "已清空自定义通道配置");
    } catch (err) {
      showActionErrorModal("清空自定义通道", err);
    }
  };
}

function showChangePasswordError(msg) {
  if (!el.changePasswordError) return;
  if (msg) {
    el.changePasswordError.textContent = msg;
    el.changePasswordError.classList.remove("hidden");
  } else {
    el.changePasswordError.textContent = "";
    el.changePasswordError.classList.add("hidden");
  }
}

function openChangePasswordModal() {
  showChangePasswordError("");
  el.oldPasswordInput && (el.oldPasswordInput.value = "");
  el.newPasswordInput && (el.newPasswordInput.value = "");
  el.changePasswordModal?.classList.remove("hidden");
  setTimeout(() => el.oldPasswordInput?.focus(), 0);
}

function closeChangePasswordModal() {
  el.changePasswordModal?.classList.add("hidden");
  showChangePasswordError("");
}

async function submitChangePassword() {
  const oldPassword = String(el.oldPasswordInput?.value || "");
  const newPassword = String(el.newPasswordInput?.value || "");
  if (!oldPassword) return showChangePasswordError("请先输入旧密码");
  if (!newPassword || newPassword.length < 6) return showChangePasswordError("新密码至少 6 位");
  showChangePasswordError("");
  await withFeedback(
    "修改密码",
    async () => {
      await postJson("/api/settings/change-password", { oldPassword, newPassword });
    },
    "密码修改成功"
  );
  closeChangePasswordModal();
}

el.openChangePasswordBtn.onclick = () => openChangePasswordModal();
el.closeChangePasswordBtn.onclick = () => closeChangePasswordModal();
el.cancelChangePasswordBtn.onclick = () => closeChangePasswordModal();
el.changePasswordModal.onclick = (e) => {
  if (e.target === el.changePasswordModal) closeChangePasswordModal();
};
el.confirmChangePasswordBtn.onclick = () => submitChangePassword();
el.newPasswordInput.onkeydown = (e) => {
  if (e.key === "Enter") submitChangePassword();
};

el.openAiChatBtn.onclick = () => {
  closeMobileSidebar();
  openAiChatModal();
};
el.closeAiChatBtn.onclick = () => closeAiChatModal();
el.aiChatModal.onclick = (e) => {
  if (e.target === el.aiChatModal) closeAiChatModal();
};
el.sendAiChatBtn.onclick = () => sendAiChatMessage();
el.clearAiChatBtn.onclick = () => {
  state.aiChatMessages = [];
  ensureAiChatGreeting();
  renderAiChatMessages();
};
el.aiChatInput.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendAiChatMessage();
  }
};

el.logoutBtn.onclick = async () => {
  await postJson("/api/auth/logout", {});
  window.location.href = "/login.html";
};

el.tabButtons.forEach((b) => (b.onclick = () => setActiveTab(b.dataset.tab)));

if (el.sidebarMenuBtn) el.sidebarMenuBtn.onclick = () => toggleMobileSidebar();
if (el.sidebarBackdrop) el.sidebarBackdrop.onclick = () => closeMobileSidebar();
window.addEventListener("resize", () => {
  if (!isMobileLayout()) closeMobileSidebar();
});
if (el.projectList) {
  el.projectList.addEventListener("click", (e) => {
    if (!isMobileLayout()) return;
    if (e.target.closest(".project-item-main") || e.target.closest(".project-delete-btn")) closeMobileSidebar();
  });
}

el.novelFileInput.onchange = async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (!/\.txt|\.md/i.test(f.name)) return log("仅支持 txt/md 直读。");
  el.novelTextInput.value = await f.text();
  log(`已读取 ${f.name}`);
  if (state.currentProjectId) el.splitChaptersBtn.click();
};

el.splitChaptersBtn.onclick = async () => {
  if (!state.currentProjectId) return log("请先选择项目");
  const novelText = el.novelTextInput.value.trim();
  if (!novelText) return log("请先输入/上传小说");
  await withFeedback("章节拆解", async () => {
    let resp, data;
    try {
      resp = await fetch(`/api/projects/${state.currentProjectId}/novel/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ novelText, sourceName: "web_input" }),
        credentials: "include",
      });
      data = await resp.json();
    } catch (fetchErr) {
      throw fetchErr;
    }
    if (resp.status === 409) {
      // Keep feedback state consistent: this is not "completed", but a guided stop.
      throw new Error(data?.error || "章节已存在，请使用「追加章节」或「重新拆解章节」");
    }
    if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
    state.workspace.chapters = data.chapters || [];
    renderChapterChecklist();
    fillChapterSelect(el.outlineChapterSelect, true);
    fillChapterSelect(el.assetsChapterSelect, false);
  });
};

el.appendChaptersBtn.onclick = async () => {
  if (!state.currentProjectId) return log("请先选择项目");
  const novelText = el.novelTextInput.value.trim();
  if (!novelText) return log("请先输入/上传小说");
  let appendResult = null;
  try {
    await withFeedback("追加章节", async () => {
      const r = await postJson(`/api/projects/${state.currentProjectId}/novel/split`, {
        novelText,
        sourceName: "web_input",
        append: true,
      });
      appendResult = r;
      state.workspace.chapters = r.chapters || [];
      renderChapterChecklist();
      fillChapterSelect(el.outlineChapterSelect, true);
      fillChapterSelect(el.assetsChapterSelect, false);
    });
    // Log AFTER withFeedback so it's not overwritten by "追加章节 - 完成"
    if (appendResult) {
      const added = appendResult.added ?? 0;
      const skipped = appendResult.skipped ?? 0;
      const autoTitledCount = appendResult.autoTitledCount ?? 0;
      const total = (appendResult.chapters || []).length;
      if (added > 0) {
        const autoNote = autoTitledCount > 0 ? `（其中 ${autoTitledCount} 章无章节标识，已自动编号）` : "";
        log(`已追加 ${added} 章${autoNote}，当前共 ${total} 章${skipped > 0 ? `，跳过 ${skipped} 个同名章节` : ""}`);
      } else {
        log(`未追加新章节（跳过 ${skipped} 个同名章节）。请确认文本框中包含新章节内容，或使用「重新拆解章节」替换全部。`);
      }
    }
  } catch (err) {
    log(`追加章节失败：${err?.message || err}`);
  }
};

el.reSplitChaptersBtn.onclick = async () => {
  if (!state.currentProjectId) return log("请先选择项目");
  const novelText = el.novelTextInput.value.trim();
  if (!novelText) return log("请先输入/上传小说");
  if (!confirm("重新拆解将覆盖已有章节及其关联的大纲、资产数据，是否继续？")) return;
  await withFeedback("重新拆解章节", async () => {
    const r = await postJson(`/api/projects/${state.currentProjectId}/novel/split`, {
      novelText,
      sourceName: "web_input",
      overwrite: true,
    });
    state.workspace.chapters = r.chapters || [];
    state.loadedOutline = null;
    state.loadedAssets = null;
    renderChapterChecklist();
    fillChapterSelect(el.outlineChapterSelect, true);
    fillChapterSelect(el.assetsChapterSelect, false);
  });
};

el.selectAllChaptersBtn.onclick = () => {
  el.chapterCheckboxList.querySelectorAll(".chapter-item").forEach((row) => {
    const ck = row.querySelector("input[type=checkbox]");
    if (ck) { ck.checked = true; state.selectedChapterIds.add(ck.value); }
    row.classList.add("is-checked");
  });
};
el.clearAllChaptersBtn.onclick = () => {
  el.chapterCheckboxList.querySelectorAll(".chapter-item").forEach((row) => {
    const ck = row.querySelector("input[type=checkbox]");
    if (ck) ck.checked = false;
    row.classList.remove("is-checked");
  });
  state.selectedChapterIds.clear();
};

el.chapterViewToggleBtn.onclick = () => {
  chapterCompactMode = !chapterCompactMode;
  el.chapterViewToggleBtn.textContent = chapterCompactMode ? "⊞ 紧凑视图" : "☰ 详情视图";
  renderChapterChecklist();
};

async function runExtractOutline(overwrite) {
  if (!state.currentProjectId) return log("请先选择项目");
  if (!(await warnLowBalanceBeforeRun("即将执行提取大纲任务"))) return;
  const chapterIds = Array.from(state.selectedChapterIds);
  if (!chapterIds.length) return log("请先勾选章节");
  if (overwrite && !confirm(`将重新调用 AI 覆盖 ${chapterIds.length} 章已有大纲，是否继续？`)) {
    return;
  }
  const n = chapterIds.length;
  const label = overwrite ? `重新提取大纲(${n}章)` : `提取大纲(${n}章)`;
  await withFeedback(
    label,
    async () => {
      const total = chapterIds.length;
      const allWarnings = [];
      setOverlayProgress(0, 100, `共 ${total} 章，正在提交后台排队提取…`);
      const r = await postJson(`/api/projects/${state.currentProjectId}/chapters/extract-outline`, {
        chapterIds: chapterIds,
        overwrite: !!overwrite,
        visualStyle: el.visualStyleInput.value.trim(),
      });
      
      const res = await pollTask(r.taskId, "extractOutline", (p) => {
        setOverlayProgress(p, 100, `云端队列任务执行中（排队及处理进度 ${p}%）...`);
      });

      if (Array.isArray(res?.warnings)) allWarnings.push(...res.warnings);
      if (allWarnings.length) {
        const tip = allWarnings.find((w) => w?.code === "UPSTREAM_BUSY_429")?.message;
        log(tip || "提示：上游繁忙，本次部分步骤已跳过。建议在【设置】中切换模型后重试。");
      }
      await refreshWorkspace();
      setActiveTab("outline");

      const firstId = chapterIds[0];
      if (firstId) {
        el.outlineChapterSelect.value = firstId;
        const ch = state.workspace.chapters.find((c) => c.id === firstId);
        if (ch?.hasOutline) {
          try {
            const d = await getJson(`/api/projects/${state.currentProjectId}/chapters/${firstId}/outline`);
            state.loadedOutline = d;
            state.outlineCardsByModule = parseOutlineToModules(d);
            state.outlineModule = "characters";
            renderOutlineModule();
          } catch (e) {
            console.warn("Auto-load outline failed:", e);
          }
        }
      }
    },
    overwrite ? "重新提取完成，人物与场景已写入对应板块" : "大纲提取完成",
    { loadingText: "AI 正在按导演阶段1与剧本分析技能拆解人物/场景，请稍候…" }
  );
}

el.extractOutlineBtn.onclick = () => runExtractOutline(false);

el.reExtractOutlineBtn.onclick = () => runExtractOutline(true);

/* ---- Outline ---- */

el.loadOutlineBtn.onclick = async () => {
  const chapterId = el.outlineChapterSelect.value;
  if (!chapterId) return;
  const chapter = state.workspace.chapters.find((c) => c.id === chapterId);
  if (!chapter?.hasOutline) return log("未拆解 - 请返回上一步先拆解大纲");
  await withFeedback("加载章节大纲", async () => {
    const d = await getJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/outline`);
    state.loadedOutline = d;
    state.outlineCardsByModule = parseOutlineToModules(d);
    state.outlineModule = "characters";
    renderOutlineModule();
  });
};

el.saveOutlineModuleBtn.onclick = async () => {
  const chapterId = el.outlineChapterSelect.value;
  if (!chapterId || !state.loadedOutline) return log("请先加载大纲");
  await withFeedback(`保存${state.outlineModule}板块`, async () => {
    const merged = { ...state.loadedOutline, ...modulesToOutline(state.outlineCardsByModule) };
    await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/outline/save`, merged);
    state.loadedOutline = merged;
    await refreshWorkspace();
  }, "板块保存成功");
};

el.saveOutlineBtn.onclick = async () => {
  const chapterId = el.outlineChapterSelect.value;
  if (!chapterId || !state.loadedOutline) return log("请先加载大纲");
  await withFeedback("保存大纲编辑", async () => {
    const merged = { ...state.loadedOutline, ...modulesToOutline(state.outlineCardsByModule) };
    await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/outline/save`, merged);
    state.loadedOutline = merged;
    await refreshWorkspace();
  }, "大纲保存成功");
};

el.exportOutlineBtn.onclick = () => {
  const chapterId = el.outlineChapterSelect.value;
  if (!chapterId || !state.loadedOutline) return log("请先加载章节大纲再导出");
  const merged = { ...state.loadedOutline, ...modulesToOutline(state.outlineCardsByModule) };
  const scriptMd = [
    "# 剧本分析报告",
    "## 人物清单",
    merged.charactersMd || "",
    "## 场景清单",
    merged.scenesMd || "",
    "## 物品清单",
    merged.itemsMd || "",
    "## 故事线",
    merged.storylineMd || "",
  ].join("\n\n");
  downloadTextFile(`${chapterId}_script_analysis.md`, scriptMd);
  downloadTextFile(`${chapterId}_outline.json`, JSON.stringify(merged, null, 2));
  log("大纲导出完成（script_analysis.md + outline.json）");
};

/* ---- Assets ---- */

el.loadAssetsBtn.onclick = async () => {
  const chapterId = el.assetsChapterSelect.value;
  if (!chapterId) return;
  const chapter = state.workspace.chapters.find((c) => c.id === chapterId);
  if (!chapter?.hasAssets) return log("未生成资产 - 请先点击「生成当前章节资产」");
  await withFeedback("加载章节资产", async () => {
    const d = await getJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/assets`);
    state.loadedAssets = d;
    state.assetCardsByModule = parseAssetsToModules(d);
    state.assetModule = "storyboard";
    renderAssetModule();
  });
};

el.generateCurrentChapterAssetsBtn.onclick = async () => {
  if (!state.currentProjectId) return log("请先选择项目");
  if (!(await warnLowBalanceBeforeRun("即将生成当前章节资产"))) return;
  const chapterId = el.assetsChapterSelect.value;
  if (!chapterId) return log("请先在下拉框中选择章节");
  await withFeedback(
    "生成当前章节资产",
    async () => {
      const ch = state.workspace.chapters.find((c) => c.id === chapterId);
      const title = ch?.title || chapterId;
      setOverlayProgress(0, 100, `正在基于本章大纲生成分镜与提示词（人物/场景/物品复用大纲）\n${title}`);
      const r = await postJson(`/api/projects/${state.currentProjectId}/chapters/generate-assets`, {
        chapterIds: [chapterId],
        overwrite: true,
      });

      const res = await pollTask(r.taskId, "generateAssets", (p) => {
        setOverlayProgress(p, 100, `云端生成队列执行中（资产组装及处理进度 ${p}%）...`);
      });

      const resOne = Array.isArray(res?.results) ? res.results.find((x) => x.chapterId === chapterId) : null;
      if (resOne?.skipped && resOne?.reason === "missing_outline") {
        throw new Error("请先在「章节大纲」中提取本章大纲，再生成资产。");
      }
      if (resOne?.resumed) {
        log("已从断点续跑：仅补全分镜提示词（未重复生成分镜脚本）。若曾刷新页面，也可点「加载该章节资产」查看已落盘结果。");
      }
      const warns = Array.isArray(res?.warnings) ? res.warnings : [];
      if (warns.length) {
        const miss = warns.find((w) => w?.code === "MISSING_OUTLINE");
        if (miss?.message) log(miss.message);
        const tip = warns.find((w) => w?.code === "UPSTREAM_BUSY_429")?.message;
        if (tip) log(tip);
        else if (!miss) log("提示：上游繁忙，本次部分步骤已跳过。建议在【设置】中切换模型后重试。");
      }
      setOverlayProgress(1, 1, `本章节处理完成：${title}`);
      await refreshWorkspace();
      const d = await getJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/assets`);
      state.loadedAssets = d;
      state.assetCardsByModule = parseAssetsToModules(d);
      state.assetModule = "storyboard";
      renderAssetModule();
    },
    "当前章节资产已生成完毕",
    { loadingText: "AI 正在生成本章节剧本资产（分镜/提示词等），请稍候…" }
  );
};

el.saveAssetsModuleBtn.onclick = async () => {
  const chapterId = el.assetsChapterSelect.value;
  if (!chapterId || !state.loadedAssets) return log("请先加载资产");
  await withFeedback(`保存${state.assetModule}板块`, async () => {
    const merged = { ...state.loadedAssets, ...modulesToAssets(state.assetCardsByModule) };
    await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/assets/save`, merged);
    state.loadedAssets = merged;
    await refreshWorkspace();
  }, "板块保存成功");
};

el.saveAssetsBtn.onclick = async () => {
  const chapterId = el.assetsChapterSelect.value;
  if (!chapterId || !state.loadedAssets) return log("请先加载资产");
  await withFeedback("保存资产编辑", async () => {
    const merged = { ...state.loadedAssets, ...modulesToAssets(state.assetCardsByModule) };
    await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/assets/save`, merged);
    state.loadedAssets = merged;
    await refreshWorkspace();
  }, "资产保存成功");
};

el.exportAssetsBtn.onclick = () => {
  const chapterId = el.assetsChapterSelect.value;
  if (!chapterId || !state.loadedAssets) return log("请先加载章节资产再导出");
  const merged = { ...state.loadedAssets, ...modulesToAssets(state.assetCardsByModule) };
  downloadTextFile(`${chapterId}_assets.json`, JSON.stringify(merged, null, 2));
  if (merged.storyboardMd) downloadTextFile(`${chapterId}_storyboard.md`, merged.storyboardMd);
  log("资产导出完成");
};

el.generateAssetsBtn.onclick = async () => {
  const chapterId = el.assetsChapterSelect.value;
  if (!chapterId) return;
  if (!state.loadedAssets) return log("请先加载章节资产");
  if (!["characters", "scenes", "items"].includes(state.assetModule)) {
    return log("请切换到人物/场景/物品板块再选中资产润色");
  }
  const selected = currentAssetCards().filter((c) => c.selected);
  if (!selected.length) return log("请先勾选要重生成/润色的资产");

  await withFeedback(
    `润色选中资产(${selected.length})`,
    async () => {
      const total = selected.length;
      const map = new Map();
      setOverlayProgress(0, total, `共 ${total} 条，准备润色…`);
      for (let i = 0; i < selected.length; i += 1) {
        const e = selected[i];
        const label = e.title || e.id || `条目${i + 1}`;
        setOverlayProgress(i, total, `正在润色第 ${i + 1}/${total} 条：${label}`);
        const r = await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/assets/refine`, {
          moduleType: state.assetModule,
          entries: [{ id: e.id, title: e.title, content: e.content }],
          visualStyle: el.visualStyleInput.value.trim(),
        });
        (r.refined || []).forEach((x) => map.set(x.id, x.content));
        setOverlayProgress(i + 1, total, `已完成 ${i + 1}/${total} 条：${label}`);
      }
      currentAssetCards().forEach((c) => {
        if (map.has(c.id)) c.content = map.get(c.id);
      });
      renderAssetModule();
    },
    "选中资产已润色完成",
    { loadingText: "AI 正在润色选中条目，请稍候…" }
  );
};

el.generateAllAssetsBtn.onclick = async () => {
  if (!(await warnLowBalanceBeforeRun("即将一键生成全部资产"))) return;
  const allIds = state.workspace.chapters.map((c) => c.id);
  if (!allIds.length) return log("暂无章节");
  await withFeedback(
    `一键生成全部资产(${allIds.length}章)`,
    async () => {
      const total = allIds.length;
      const allWarnings = [];
      setOverlayProgress(0, 100, `共 ${total} 章，正在提交后台批量排队生成…`);
      let r = await postJson(`/api/projects/${state.currentProjectId}/chapters/generate-assets`, {
        chapterIds: allIds,
        overwrite: false,
      });

      let res = await pollTask(r.taskId, "generateAssets", (p) => {
        setOverlayProgress(p, 100, `云端生成队列执行中（资产组装及处理进度 ${p}%）...`);
      });
      const rows = Array.isArray(res?.results) ? res.results : [];
      const skippedCount = rows.filter((x) => x?.skipped).length;
      // 历史空资产会被视为“已存在”，这里自动二次覆盖生成，避免用户看到“闪一下就结束”。
      if (rows.length > 0 && skippedCount === rows.length) {
        setOverlayProgress(0, 100, "检测到全部章节均被跳过，正在自动执行覆盖重生成…");
        r = await postJson(`/api/projects/${state.currentProjectId}/chapters/generate-assets`, {
          chapterIds: allIds,
          overwrite: true,
        });
        res = await pollTask(r.taskId, "generateAssets", (p) => {
          setOverlayProgress(p, 100, `覆盖生成中（资产组装及处理进度 ${p}%）...`);
        });
      }

      if (Array.isArray(res?.warnings)) allWarnings.push(...res.warnings);
      if (allWarnings.length) {
        const missN = allWarnings.filter((w) => w?.code === "MISSING_OUTLINE").length;
        if (missN) log(`有 ${missN} 章未提取大纲，已跳过；请先对各章执行「章节大纲」。`);
        const tip = allWarnings.find((w) => w?.code === "UPSTREAM_BUSY_429")?.message;
        if (tip) log(tip);
        else if (!missN) log("提示：上游繁忙，本次部分步骤已跳过。建议在【设置】中切换模型后重试。");
      }
      await refreshWorkspace();
      setActiveTab("assets");
      const firstReady = state.workspace.chapters.find((c) => c.hasAssets)?.id;
      if (firstReady) {
        el.assetsChapterSelect.value = firstReady;
        try {
          const d = await getJson(`/api/projects/${state.currentProjectId}/chapters/${firstReady}/assets`);
          state.loadedAssets = d;
          state.assetCardsByModule = parseAssetsToModules(d);
          state.assetModule = "storyboard";
          renderAssetModule();
        } catch (e) {
          console.warn("Auto-load assets failed:", e);
        }
      }
    },
    "全部章节资产生成任务已完成（已存在资产或无大纲的章节会跳过）",
    { loadingText: "AI 正在批量生成各章节资产，请稍候…" }
  );
};

/* ---- Custom add entry + AI polish ---- */

el.addAssetEntryBtn.onclick = () => {
  const moduleType = state.assetModule;
  const cards = currentAssetCards();
  const mapLabel = {
    characters: "人物",
    scenes: "场景",
    items: "物品",
    storyboard: "分镜脚本",
    storyboardPrompts: "分镜提示词",
    chapterText: "章节文本",
  };
  const label = mapLabel[moduleType] || "条目";
  const title = prompt(`请输入新${label}名称`, `自定义${label}${cards.length + 1}`);
  if (!title) return;
  const newId = `custom_${moduleType}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const newCard = { id: newId, title, content: "", selected: false };
  cards.push(newCard);
  renderAssetModule();
  log(`已添加新${label}「${title}」，请在内容区域编辑后可点击「AI 润色当前板块」进行润色。`);
};

el.polishAssetEntryBtn.onclick = async () => {
  const moduleType = state.assetModule;
  if (!["characters", "scenes", "items", "storyboard", "storyboardPrompts"].includes(moduleType)) {
    return log("当前板块不支持 AI 润色");
  }
  const chapterId = el.assetsChapterSelect.value;
  if (!state.currentProjectId) return log("请先选择项目");
  if (!chapterId) return log("请先选择章节");

  const allCards = currentAssetCards();
  if (!allCards.length) return log("当前板块没有条目，请先添加");

  // Only polish selected (checked) entries
  const selected = allCards.filter((c) => c.selected);
  if (!selected.length) return log("请先勾选要润色的条目");

  // For storyboard / storyboardPrompts, treat as single-entry
  const polishModuleType = (moduleType === "storyboard" || moduleType === "storyboardPrompts") ? "storyboard" : moduleType;

  if (!(await warnLowBalanceBeforeRun(`即将调用 AI 润色 ${selected.length} 条选中条目`))) return;

  await withFeedback(
    `AI 润色${selected.length}条`,
    async () => {
      const total = selected.length;
      const map = new Map();
      setOverlayProgress(0, total, `共 ${total} 条，准备润色…`);
      for (let i = 0; i < selected.length; i += 1) {
        const e = selected[i];
        const entryLabel = e.title || e.id || `条目${i + 1}`;
        setOverlayProgress(i, total, `正在润色第 ${i + 1}/${total} 条：${entryLabel}`);
        const r = await postJson(`/api/projects/${state.currentProjectId}/chapters/${chapterId}/assets/refine`, {
          moduleType: polishModuleType,
          entries: [{ id: e.id, title: e.title, content: e.content }],
          visualStyle: el.visualStyleInput.value.trim(),
        });
        (r.refined || []).forEach((x) => map.set(x.id, x.content));
        setOverlayProgress(i + 1, total, `已完成 ${i + 1}/${total} 条：${entryLabel}`);
      }
      allCards.forEach((c) => {
        if (map.has(c.id)) c.content = map.get(c.id);
      });
      renderAssetModule();
    },
    "选中条目 AI 润色完成",
    { loadingText: "AI 正在按内置模板润色选中条目，请稍候…" }
  );
};

bindModuleButtons();

window.addEventListener("beforeunload", (e) => {
  const ov = $("actionOverlay");
  if (ov && !ov.classList.contains("hidden")) {
    e.preventDefault();
    e.returnValue = "";
  }
});

init().catch((e) => log(`初始化失败：${e.message}`));
