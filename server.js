const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const session = require("express-session");
const { AsyncLocalStorage } = require("async_hooks");
const { RedisStore } = require("connect-redis");
const Redis = require("ioredis");
const querystring = require("querystring");
const { TaskManager } = require("./taskManager");
const { connectDB, CustomModels, User, Order, Project, Chapter, Outline, Asset, ProjectAsset } = require("./db");

dotenv.config();
process.env.NODE_ENV = process.env.NODE_ENV || "development";
const port = Number(process.env.PORT || 3200);
const DEFAULT_OIOIAPI_BASE_URL = "https://oioiapi.site/v1";
let cachedOioiapiBaseUrl = "";
/** OpenAI 兼容基址。优先级：管理后台写入 Mongo 的 oioiapiBaseUrl，其次 .env 的 OIOIAPI_BASE_URL，最后默认官方基址。 */
function effectiveOioiapiBaseUrl() {
  const fromDb = String(cachedOioiapiBaseUrl || "").trim().replace(/\/+$/g, "");
  if (fromDb) return fromDb;
  const fromEnv = String(process.env.OIOIAPI_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/g, "");
  return DEFAULT_OIOIAPI_BASE_URL;
}
const CUSTOM_TEXT_KEY_CIPHER_PREFIX = "enc:v1";
const customTextKeySecretRaw = String(process.env.CUSTOM_KEY_ENCRYPTION_SECRET || "").trim();
const customTextKey = customTextKeySecretRaw
  ? crypto.createHash("sha256").update(customTextKeySecretRaw).digest()
  : null;

function formatUpstreamTextFetchError(err, targetUrl) {
  const u = String(targetUrl || "");
  const cause = err && err.cause;
  const code = (cause && cause.code) || err?.code;
  const core = [err && err.message, cause && String(cause.message || cause)].filter(Boolean).join(" ");
  return `无法连接上游（${u}）：${core}${code ? ` [${code}]` : ""}`;
}

const USER_FACING_UPSTREAM = "服务商网络问题";

function userFacingSettingsChatError(err) {
  const m = String(err?.message || err || "");
  if (/积分不足|请先充值/.test(m)) return m;
  const code = (err && err.cause && err.cause.code) || err?.code;
  if (m.includes("无法连接上游") || /\bfetch failed\b/i.test(m) || m.includes("read ECONNRESET")) {
    return USER_FACING_UPSTREAM;
  }
  if (code && /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)$/.test(String(code))) {
    return USER_FACING_UPSTREAM;
  }
  if (
    /socket hang up|Connection reset|connect ETIMEDOUT|network (?:error|request failed)/i.test(m) ||
    m.includes("UND_ERR_")
  ) {
    return USER_FACING_UPSTREAM;
  }
  if (m.startsWith("LLM流式调用失败:") || m.startsWith("LLM调用失败:")) {
    return USER_FACING_UPSTREAM;
  }
  if (m.length > 200) return USER_FACING_UPSTREAM;
  return m;
}

// Connect to MongoDB, migrate, then 加载 CustomModels（含 oioiapi 基址缓存），避免在库未连上时读不到后台配置
connectDB()
  .then(() => migrateUsersFromJson())
  .then(() => runMongoBackup())
  .then(() => loadCustomModels())
  .catch((e) => console.error("[Xflow] DB 初始化后加载 CustomModels 失败", e));

const app = express();
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean)
  : null;
app.use(cors(allowedOrigins ? {
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS blocked"));
  },
  credentials: true,
} : undefined));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
let redisClient = null;
let sessionStore = new session.MemoryStore();

if (process.env.REDIS_URL) {
  try {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null, // Required by bullmq later
      retryStrategy(times) {
        return Math.min(times * 100, 3000);
      }
    });

    // connect-redis v9 expects node-redis v4 API: client.set(key, val, {EX: seconds})
    // ioredis uses positional args: client.set(key, val, 'EX', seconds)
    // Wrap ioredis client with a compatibility shim for connect-redis v9.
    const ioredisShim = {
      get: (key) => redisClient.get(key),
      set: (key, value, opts) => {
        if (opts && opts.EX) return redisClient.set(key, value, 'EX', opts.EX);
        if (opts && opts.PX) return redisClient.set(key, value, 'PX', opts.PX);
        return redisClient.set(key, value);
      },
      del: (...keys) => redisClient.del(...keys),
      expire: (key, ttl) => redisClient.expire(key, ttl),
      mget: (...keys) => redisClient.mget(...keys),
      keys: (pattern) => redisClient.keys(pattern),
      scan: (cursor, ...args) => redisClient.scan(cursor, ...args),
    };

    sessionStore = new RedisStore({ client: ioredisShim, prefix: "xflowsess:" });
    const safeRedisUrl = (process.env.REDIS_URL || "").replace(/:([^@/]+)@/, ":***@");
    console.log("[Redis] Session Store connected to:", safeRedisUrl);
  } catch (err) {
    console.error("[Redis] Connection failed, falling back to MemoryStore", err);
  }
} else {
  console.log("[Warning] REDIS_URL not set in .env. Using in-memory session (Will lose sessions on restart/cluster load balancing).");
}

const taskManager = new TaskManager(redisClient);

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || "xflow_session_secret_dev",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 3600 * 1000,
    },
  })
);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
app.use("/api/", globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, please try again later" },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/verify-sms", authLimiter);
app.use("/api/auth/reset-password", authLimiter);

const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment requests, please try again later" },
});
app.use("/api/pay/", payLimiter);

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
const ALLOWED_STATIC = new Set([
  "index.html", "login.html", "workspace.html", "admin.html", "recharge.html", "pay_alipay.html",
  "style.css", "app.js", "admin.js", "auth.js", "recharge.js",
  "helpers_block.js", "projects_list_route.js",
  "favicon.ico",
]);
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const relPath = decodeURIComponent(req.path).replace(/^\/+/, "");
  if (ALLOWED_STATIC.has(relPath)) {
    // Dev-first: prevent browser from serving stale HTML/JS/CSS after local edits.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    return res.sendFile(path.join(__dirname, relPath));
  }
  next();
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const OUTPUT_ROOT = path.join(__dirname, "output");
ensureDir(OUTPUT_ROOT);
app.use("/output", express.static(OUTPUT_ROOT));

const SKILL_DIR = "./Xflow/剧本拆解skill";
const SKILLS = {
  director: path.join(SKILL_DIR, "ai-short-video-director-SKILL.md"),
  analyzer: path.join(SKILL_DIR, "script-analyzer-SKILL.md"),
  storyboard: path.join(SKILL_DIR, "storyboard-sesigner-SKILL.md"),
  storyline: path.join(SKILL_DIR, "stroy-line-SKLII.md"),
  toolPolish: path.join(SKILL_DIR, "tool-polish-SKILL.md"),
  outlineDirector: path.join(SKILL_DIR, "outlineScript-director-SKILL.md"),
};

const DEFAULT_MODEL_OPTIONS = [
  {
    modelId: "qwen3-max",
    modelName: "通义千问 Qwen3-Max",
    hint: "长文本超强，中文理解好",
  },
  {
    modelId: "gpt-5.4-mini",
    modelName: "Chat-GPT-5.4-Mini",
    hint: "性价比高",
  },
  {
    modelId: "deepseek-v3.2",
    modelName: "DeepSeek-V3.2",
    hint: "比较均衡中文能力强",
  },
];

const DEFAULT_IMAGE_MODEL_OPTIONS = [
  {
    modelId: "nano-banana2",
    modelName: "Nano banana2（最强画质·推荐）",
    // 当前接入 ToAPIs 的实际模型参数，默认沿用可用值
    toapisModel: process.env.TOAPIS_IMAGE_MODEL_NANO || process.env.TOAPIS_IMAGE_MODEL || "gemini-3.1-flash-image-preview",
    pointsCost: 50,
  },
  {
    modelId: "gpt-image-2",
    modelName: "GPT Image 2",
    toapisModel: process.env.TOAPIS_IMAGE_MODEL_GPTIMAGE || "gpt-image-2",
    pointsCost: 50,
  },
  {
    modelId: "doubao-seedream-5-0",
    modelName: "豆包 Seedream 5.0",
    toapisModel: process.env.TOAPIS_IMAGE_MODEL_SEEDREAM || "doubao-seedream-5-0",
    pointsCost: 40,
  },
];

let MODEL_OPTIONS = [...DEFAULT_MODEL_OPTIONS];
let IMAGE_MODEL_OPTIONS = [...DEFAULT_IMAGE_MODEL_OPTIONS];

let CUSTOM_TEXT_PRICING = {};
let CUSTOM_IMAGE_PRICING = {};

function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function loadCustomModels() {
  const customs = await CustomModels.findOne({ key: "singleton" }).lean() || { textModels: [], imageModels: [] };
  cachedOioiapiBaseUrl = String(customs.oioiapiBaseUrl || "").trim();

  const validText = Array.isArray(customs.textModels) ? customs.textModels : [];
  const validImage = Array.isArray(customs.imageModels) ? customs.imageModels : [];

  MODEL_OPTIONS = [...DEFAULT_MODEL_OPTIONS, ...validText.map(t => ({
    modelId: String(t.modelId || "").trim(),
    modelName: String(t.modelName || "").trim(),
    hint: String(t.hint || "").trim()
  }))];

  IMAGE_MODEL_OPTIONS = [...DEFAULT_IMAGE_MODEL_OPTIONS, ...validImage.map(img => ({
    modelId: String(img.modelId || "").trim(),
    modelName: String(img.modelName || "").trim(),
    toapisModel: String(img.toapisModel || "").trim(),
    pointsCost: Number(img.pointsCost) || 20
  }))];

  CUSTOM_TEXT_PRICING = {};
  for (const t of validText) {
    if (t.modelId) {
      CUSTOM_TEXT_PRICING[t.modelId] = {
        prompt: Number(t.promptCost) || 3.0,
        completion: Number(t.completionCost) || 24.0
      };
    }
  }

  CUSTOM_IMAGE_PRICING = {};
  for (const img of validImage) {
    if (img.modelId) {
      CUSTOM_IMAGE_PRICING[img.modelId] = {
        pointsCost: Number(img.pointsCost) || 20
      };
    }
  }
}

const IMAGE_ASPECT_RATIO_OPTIONS = ["1:1", "16:9", "9:16"];

const requestContext = new AsyncLocalStorage();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}


function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf-8");
}

function normalizeBearerToken(raw) {
  return String(raw || "").replace(/^Bearer\s+/i, "").trim();
}

function maskApiKey(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.length <= 8) return `${v.slice(0, 1)}****${v.slice(-1)}`;
  return `${v.slice(0, 4)}****${v.slice(-4)}`;
}

function encryptCustomTextApiKey(plain) {
  const v = String(plain || "").trim();
  if (!v) return "";
  if (!customTextKey) return v;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", customTextKey, iv);
  const encrypted = Buffer.concat([cipher.update(v, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CUSTOM_TEXT_KEY_CIPHER_PREFIX}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptCustomTextApiKey(stored) {
  const v = String(stored || "").trim();
  if (!v) return "";
  if (!v.startsWith(`${CUSTOM_TEXT_KEY_CIPHER_PREFIX}:`)) return v;
  if (!customTextKey) return "";
  const parts = v.split(":");
  if (parts.length !== 5) return "";
  try {
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const encrypted = Buffer.from(parts[4], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", customTextKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return String(decrypted || "").trim();
  } catch {
    return "";
  }
}

function hasStoredCustomTextApiKey(customTextModel) {
  return Boolean(String(customTextModel?.apiKey || "").trim());
}

function resolveCustomTextApiKey(customTextModel) {
  return decryptCustomTextApiKey(customTextModel?.apiKey);
}

function getToapisImageConfig(user) {
  let apiKey = String(process.env.TOAPIS_API_KEY || "").trim();
  const openaiBase = String(process.env.OPENAI_BASE_URL || "").trim();
  if (!apiKey && /toapis\.com/i.test(openaiBase)) {
    apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  }
  const baseUrl = String(process.env.TOAPIS_BASE_URL || "https://toapis.com").trim().replace(/\/+$/g, "");
  const imageModelId = resolveUserImageModelId(user);
  const model = resolveToapisModelByImageModelId(imageModelId);
  const size = resolveUserImageAspectRatio(user);
  const resolution = String(process.env.TOAPIS_IMAGE_RESOLUTION || "2K").trim();
  return { apiKey: normalizeBearerToken(apiKey), baseUrl, model, size, resolution, imageModelId };
}

function normalizeAssetTitleKey(title) {
  return `title:${String(title || "").trim().toLowerCase()}`;
}

function imageExtByContentType(contentType, fallback) {
  const c = String(contentType || "").toLowerCase();
  if (c.includes("png")) return "png";
  if (c.includes("webp")) return "webp";
  if (c.includes("gif")) return "gif";
  if (c.includes("bmp")) return "bmp";
  if (c.includes("jpeg") || c.includes("jpg")) return "jpg";
  return fallback || "png";
}

function publicUrlFromAbsPath(absPath) {
  const rel = path.relative(__dirname, absPath).split(path.sep).join("/");
  return `/${rel}`;
}

function parseDataUrlImage(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
  if (!m) return null;
  const mimeType = String(m[1] || "image/png").toLowerCase();
  const ext = imageExtByContentType(mimeType, "png");
  return { mimeType, ext, buffer: Buffer.from(m[2] || "", "base64") };
}

async function uploadImageToToapis({ apiKey, baseUrl, buffer, mimeType, filename }) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType || "image/png" });
  form.append("file", blob, filename || `upload.${imageExtByContentType(mimeType, "png")}`);

  let resp;
  try {
    resp = await fetch(`${baseUrl}/v1/uploads/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });
  } catch (err) {
    throw new Error(`上传参考图网络失败: ${err?.message || err}`);
  }
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) {
    throw new Error(data?.error?.message || data?.message || `上传参考图失败: HTTP ${resp.status}`);
  }
  const url = data?.url;
  if (!url) throw new Error("上传参考图失败：未返回 URL");
  return String(url);
}

async function normalizeToapisReferenceImages(referenceImages, { apiKey, baseUrl }) {
  if (!Array.isArray(referenceImages) || referenceImages.length === 0) return [];
  const out = [];
  for (const ref of referenceImages.slice(0, 4)) {
    const one = String(ref || "").trim();
    if (!one) continue;
    if (/^https?:\/\//i.test(one)) {
      out.push(one);
      continue;
    }
    const parsed = parseDataUrlImage(one);
    if (parsed && parsed.buffer.length > 0) {
      const url = await uploadImageToToapis({
        apiKey,
        baseUrl,
        buffer: parsed.buffer,
        mimeType: parsed.mimeType,
        filename: `ref_${Date.now().toString(36)}.${parsed.ext}`,
      });
      out.push(url);
    }
  }
  return out;
}

function pickToapisTaskId(payload) {
  return String(payload?.id || payload?.task_id || payload?.taskId || "").trim();
}

function pickToapisTaskStatus(payload) {
  return String(payload?.status || payload?.state || "").trim().toLowerCase();
}

function pickToapisResultUrl(payload) {
  const fromResultList = payload?.result?.data?.[0]?.url;
  if (fromResultList) return String(fromResultList);
  const fromDataList = payload?.data?.[0]?.url;
  if (fromDataList) return String(fromDataList);
  const fromResultOne = payload?.result?.url;
  if (fromResultOne) return String(fromResultOne);
  if (payload?.url) return String(payload.url);
  return "";
}

async function createToapisImageTask({ apiKey, baseUrl, model, prompt, size, resolution, imageUrls }) {
  const body = {
    model,
    prompt,
    size,
    n: 1,
    metadata: {
      resolution,
    },
  };
  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    body.image_urls = imageUrls.map((url) => ({ url }));
  }
  let resp;
  try {
    resp = await fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`创建图片任务网络失败: ${err?.message || err}`);
  }
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) {
    throw new Error(data?.error?.message || data?.message || `创建图片任务失败: HTTP ${resp.status}`);
  }
  const id = pickToapisTaskId(data);
  if (!id) throw new Error("创建图片任务失败：未返回任务 ID");
  return { id, payload: data };
}

function getToapisImagePollOptions() {
  const timeoutRaw = Number(process.env.TOAPIS_IMAGE_POLL_TIMEOUT_MS);
  const intervalRaw = Number(process.env.TOAPIS_IMAGE_POLL_INTERVAL_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 60000 ? Math.floor(timeoutRaw) : 600000;
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw >= 1000 ? Math.floor(intervalRaw) : 2500;
  return { timeoutMs, intervalMs };
}

async function pollToapisImageTask({ apiKey, baseUrl, taskId, timeoutMs, intervalMs = 2000 }) {
  const opts = getToapisImagePollOptions();
  const limitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : opts.timeoutMs;
  const tickMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 1000 ? Number(intervalMs) : opts.intervalMs;
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    let resp;
    try {
      resp = await fetch(`${baseUrl}/v1/images/generations/${taskId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (err) {
      throw new Error(`轮询图片任务网络失败: ${err?.message || err}`);
    }
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!resp.ok) {
      throw new Error(data?.error?.message || data?.message || `查询图片任务失败: HTTP ${resp.status}`);
    }

    const status = pickToapisTaskStatus(data);
    if (status === "completed") return data;
    if (status === "failed" || status === "timed_out" || status === "timeout" || status === "cancelled") {
      const reason = data?.result?.error?.message || data?.error?.message || `任务状态 ${status}`;
      throw new Error(`图片任务失败：${reason}`);
    }

    await new Promise((r) => setTimeout(r, tickMs));
  }
  const waitedSec = Math.round((Date.now() - started) / 1000);
  const capSec = Math.round(limitMs / 1000);
  throw new Error(
    `图片任务超时（已等待 ${waitedSec}s，上限 ${capSec}s）。生图较慢时可增大环境变量 TOAPIS_IMAGE_POLL_TIMEOUT_MS（毫秒）后重试。`
  );
}

async function downloadRemoteImageToDir({ imageUrl, absDir }) {
  let resp;
  try {
    resp = await fetch(imageUrl);
  } catch (err) {
    throw new Error(`下载生成图片网络失败: ${err?.message || err}`);
  }
  if (!resp.ok) throw new Error(`下载生成图片失败: HTTP ${resp.status}`);
  const contentType = resp.headers.get("content-type") || "";
  const fromUrlExt = String(imageUrl).split("?")[0].split(".").pop();
  const ext = imageExtByContentType(contentType, /^[a-zA-Z0-9]+$/.test(fromUrlExt || "") ? fromUrlExt : "png");
  const fileName = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  ensureDir(absDir);
  const absPath = path.join(absDir, fileName);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(absPath, buf);
  return {
    absPath,
    publicUrl: publicUrlFromAbsPath(absPath),
  };
}

async function downloadToLocalImage({ imageUrl, userId, projectId, chapterId, moduleType }) {
  const absDir = path.join(chapterDir(userId, projectId, chapterId), "asset-images", moduleType);
  return downloadRemoteImageToDir({ imageUrl, absDir });
}

async function downloadToChatImage({ imageUrl, userId }) {
  const absDir = path.join(OUTPUT_ROOT, "chat-images", String(userId || "unknown"));
  return downloadRemoteImageToDir({ imageUrl, absDir });
}

// -----------------------------
// Alipay (PC page pay / WAP pay)
// -----------------------------
const RECHARGE_PLANS = [
  { id: "p1", priceYuan: 9.9, points: 1000, title: "Xflow 充值 1000积分" },
  { id: "p2", priceYuan: 29.9, points: 3100, title: "Xflow 充值 3100积分" },
  { id: "p3", priceYuan: 99, points: 11000, title: "Xflow 充值 11000积分" },
  { id: "p4", priceYuan: 199, points: 23000, title: "Xflow 充值 23000积分" },
];

function resolveRechargePlan(planId) {
  const id = String(planId || "").trim();
  if (!id) return null;
  return RECHARGE_PLANS.find((p) => p.id === id) || null;
}

function allowCustomPay() {
  return String(process.env.ALLOW_CUSTOM_PAY || "").trim() === "1";
}

function newOutTradeNo(prefix) {
  const p = String(prefix || "xflow").replace(/[^a-z0-9_-]/gi, "").slice(0, 10) || "xflow";
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${p}_${t}_${r}`;
}

function getPublicBaseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (env) return env.replace(/\/+$/g, "");
  const proto = req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0] : req.protocol;
  const host = req.headers["x-forwarded-host"] ? String(req.headers["x-forwarded-host"]).split(",")[0] : req.get("host");
  return `${proto}://${host}`;
}

function asPemKey(raw, kind) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/-----BEGIN [A-Z ]+-----/.test(s)) return s;
  // assume base64 DER, wrap into PEM (auto-detect for private key)
  const body = s.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) || [body];
  const wrap = (head) => `-----BEGIN ${head}-----\n${lines.join("\n")}\n-----END ${head}-----`;

  if (kind === "public") {
    const pem = wrap("PUBLIC KEY");
    // validate
    crypto.createPublicKey(pem);
    return pem;
  }

  // private: prefer PKCS1 for compatibility, then PKCS8
  const pkcs1 = wrap("RSA PRIVATE KEY");
  try {
    crypto.createPrivateKey(pkcs1);
    return pkcs1;
  } catch {
    const pkcs8 = wrap("PRIVATE KEY");
    crypto.createPrivateKey(pkcs8);
    return pkcs8;
  }
}


function buildSignContent(params) {
  const keys = Object.keys(params || {})
    .filter((k) => k && k !== "sign" && k !== "sign_type" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort();
  return keys.map((k) => `${k}=${String(params[k])}`).join("&");
}


function signZpay(params, key) {
  const content = buildSignContent(params);
  return crypto.createHash("md5").update(content + key).digest("hex");
}

function verifyZpaySign(params, key) {
  const sign = String(params.sign || "").trim().toLowerCase();
  if (!sign) return false;
  const expected = signZpay(params, key);
  return sign === expected;
}

async function zpayApiRequest(act, extraParams = {}) {
  const pid = process.env.ZPAY_PID || "";
  const key = process.env.ZPAY_KEY || "";
  // 通常 submit.php 所在的目录就是 api.php 所在的目录
  const baseUrl = (process.env.ZPAY_API_URL || "https://z-pay.cn/submit.php").replace("submit.php", "api.php");

  const params = {
    act,
    pid,
    ...extraParams
  };

  const sign = signZpay(params, key);
  const finalParams = { ...params, sign, sign_type: "MD5" };
  const url = `${baseUrl}?${querystring.stringify(finalParams)}`;

  try {
    const resp = await fetch(url);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP Error: ${resp.status} - ${text}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { code: 0, msg: "Invalid JSON response" };
    }
  } catch (err) {
    console.error(`[Z-Pay API] act=${act} failed:`, err.message);
    throw err;
  }
}

async function queryZpayOrder(outTradeNo) {
  try {
    const root = await zpayApiRequest("order", { out_trade_no: outTradeNo });
    if (root.code !== 1) return { ok: false, msg: root.msg };

    const status = Number(root.status); // 1 = paid, 0 = unpaid
    const tradeNo = root.trade_no;
    const totalAmount = root.money;

    const ord = await Order.findOne({ outTradeNo }).lean();
    if (!ord) return { ok: false, msg: "Order not found in DB" };

    const updates = { querySnapshot: root };
    if (tradeNo) updates.tradeNo = tradeNo;

    if (status === 1) {
      updates.status = "PAID";
      if (!ord.creditedAt && ord.points && ord.userId) {
        // Atomic claim: only one request can set creditedAt
        const claimed = await Order.findOneAndUpdate(
          { outTradeNo, creditedAt: { $in: [null, undefined, ""] } },
          { $set: { creditedAt: new Date().toISOString() } },
          { new: false }
        );
        if (claimed) {
          const user = await findUserById(String(ord.userId));
          if (user) {
            ensureUserBillingFields(user);
            user.pointsBalance = Number(user.pointsBalance || 0) + Number(ord.points || 0);
            user.billingUpdatedAt = new Date().toISOString();
            appendBillingLog(user, {
              type: "recharge_aggregate_sync",
              pointsAdded: Number(ord.points || 0),
              outTradeNo,
              tradeNo,
              pointsBalanceAfter: Number(user.pointsBalance || 0),
              at: user.billingUpdatedAt,
            });
            await saveUser(user);
          }
        }
      }
    }
    await Order.findOneAndUpdate({ outTradeNo }, { $set: updates });
    return { ok: true, status: updates.status || ord.status };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

async function refundZpayOrder(outTradeNo) {
  try {
    const ord = await Order.findOne({ outTradeNo }).lean();
    if (!ord) return { ok: false, msg: "Order not found" };
    if (ord.status !== "PAID") return { ok: false, msg: "Only PAID orders can be refunded" };

    const root = await zpayApiRequest("refund", { out_trade_no: outTradeNo });
    if (root.code !== 1) return { ok: false, msg: root.msg };

    // Update locally
    const next = { ...ord, status: "REFUNDED", refundedAt: new Date().toISOString(), refundSnapshot: root };
    // avoid MongoDB immutable field update errors
    delete next._id;
    delete next.__v;
    
    // Deduct points if credited
    if (next.creditedAt && next.userId && next.points) {
      const user = await findUserById(String(next.userId));
      if (user) {
        ensureUserBillingFields(user);
        const deduct = Math.min(Number(next.points || 0), Number(user.pointsBalance || 0));
        user.pointsBalance = Math.max(0, Number(user.pointsBalance || 0) - Number(next.points || 0));
        user.billingUpdatedAt = new Date().toISOString();
        appendBillingLog(user, {
          type: "refund_aggregate",
          pointsDeducted: deduct,
          pointsShortfall: Number(next.points || 0) - deduct,
          outTradeNo,
          pointsBalanceAfter: Number(user.pointsBalance || 0),
          at: user.billingUpdatedAt,
        });
        await saveUser(user);
        next.pointsRefundedAt = new Date().toISOString();
      }
    }

    await Order.findOneAndUpdate({ outTradeNo }, next, { upsert: true });
    return { ok: true, msg: "Refund success" };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

function initStatusObj() {
  return {
    todos: [
      {
        content: "阶段1：剧本分析 - 识别人物与场景",
        activeForm: "正在分析剧本，识别人物与场景",
        status: "pending",
      },
      {
        content: "阶段2：设计分镜脚本",
        activeForm: "正在设计分镜脚本",
        status: "pending",
      },
    ],
  };
}

function fallbackAnalysis(projectName, visualStyle, scriptText) {
  return `# 剧本分析报告

## 1. 关键设定检索结果
- **搜索关键词**：${projectName} 角色设定 视觉风格；核心角色 外貌描述；核心场景 环境描写
- **核心发现**：基于用户剧本做视觉补全，建立角色与场景统一风格。

## 2. 整体风格建议
- **视觉基调**：${visualStyle}
- **色调建议**：冷暖反差，冲突段落加强高对比。
- **镜头语言**：冲突用推近和切镜，情绪段落增加留停。

## 3. 人物清单
- **主角A**
  - **身份**：剧情核心角色
  - **外貌描述**：情绪细节明显，适合近景特写
  - **AI生图提示词 (Prompt)**：
    - **语言要求**：**必须使用中文**，可含必要英文词如 8k、photorealistic
    - **必含元素**：${projectName}、主角A、服饰与神态细节
    - **示例**：\`${projectName}，主角A，${visualStyle}，电影级打光，8k\`

## 4. 场景清单
- **场景1**
  - **场景类型**：室内/室外（依据剧本）
  - **环境描述**：根据剧情冲突构建空间与光影
  - **AI生图提示词 (Prompt)**：
    - **语言要求**：中文
    - **必含元素**：${projectName}、场景1、关键环境特征

## 5. 人物与场景关系图
- 角色关系在场景推进中逐步揭示，关键冲突场景承担剧情转折。

## 6. 总结
- 已完成分析，可进入分镜设计。`;
}

/** 从阶段1报告 §3 粗提人物姓名（分镜 fallback；与 formatCharactersMdFromJson 的 `- **姓名**` 卡片标题一致） */
function roughExtractCharacterNamesFromAnalysisMd(md) {
  const t = String(md || "");
  const start = t.search(/##\s*3\.\s*人物清单/i);
  if (start < 0) return [];
  const end = t.search(/##\s*4\.\s*场景清单/i);
  const slice = end > start ? t.slice(start, end) : t.slice(start, start + 12000);
  const names = [];
  const seen = new Set();
  const reList = /^-\s*\*\*([^*\n]+)\*\*\s*$/gm;
  let m;
  while ((m = reList.exec(slice))) {
    let n = m[1].trim().replace(/（[^）]*）/g, "").trim();
    if (n.length < 2 || n.length > 12) continue;
    if (/外貌|身份|描述|清单|人物|风格|提示词|生图|示例|台词|配音|关系|性格/.test(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  return names.slice(0, 16);
}

/** 从阶段1报告 §4 粗提场景名称（分镜 fallback 用；与 formatScenesMdFromJson 的 `- **标题**` 一致） */
function roughExtractSceneHeadingsFromAnalysisMd(md) {
  const t = String(md || "");
  const start = t.search(/##\s*4\.\s*场景清单/i);
  if (start < 0) return [];
  const end = t.search(/##\s*5\./i);
  const slice = end > start ? t.slice(start, end) : t.slice(start, start + 14000);
  const out = [];
  const seen = new Set();
  const reList = /^-\s*\*\*([^*\n]+)\*\*\s*$/gm;
  let m;
  while ((m = reList.exec(slice))) {
    const s = m[1].trim().replace(/（[^）]*）/g, "").trim();
    if (s.length < 2 || s.length > 36) continue;
    if (/环境描述|场景类型|必含|提示词|AI生图|场景清单/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (out.length) return out.slice(0, 10);
  const reHead = /^#{2,4}\s+(.+)$/gm;
  while ((m = reHead.exec(slice))) {
    const s = String(m[1] || "")
      .trim()
      .replace(/（[^）]*）/g, "")
      .trim();
    if (s.length < 2 || s.length > 28) continue;
    if (/场景清单|环境描述|场景类型|必含|提示词/.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.slice(0, 10);
}

function fallbackStoryboard(scriptText, analysisText) {
  const names = roughExtractCharacterNamesFromAnalysisMd(analysisText || "");
  const sceneFromAnalysis = roughExtractSceneHeadingsFromAnalysisMd(analysisText || "");
  const sceneLines = scriptText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((line) => /^(场景\d*|scene\s*\d*|INT\.|EXT\.)/i.test(line));
  let scenes =
    sceneFromAnalysis.length > 0
      ? sceneFromAnalysis.slice(0, 6)
      : sceneLines.length > 0
        ? sceneLines.slice(0, 6)
        : ["第一场（地点见场景清单）", "第二场（地点见场景清单）"];
  const pair =
    names.length >= 2 ? `${names[0]}、${names[1]}` : names.length === 1 ? `${names[0]}、（另一角色按剧本补全）` : "（请据§3人物清单填写真实姓名）";
  const first = names[0] || "主角";
  const rows = [];
  const sceneIndex = [];
  let shotNo = 1;

  scenes.forEach((scene, idx) => {
    const start = idx * 9;
    const sceneTag = scene.replace(/^【场景】/, "").trim();
    sceneIndex.push({
      scene_id: `SCENE_${idx + 1}`,
      title: sceneTag,
      start_second: start,
      end_second: start + 9,
    });
    rows.push(
      `| ${shotNo++} | ${start}-${start + 3}秒 | 建立镜头 | 【场景】${sceneTag} 【人物】${pair} 【道具/物品】无；全景交代本场空间、陈设与人物站位关系 | 全景 | 缓慢推进 | 环境氛围音+配乐 | 用具体地点名与角色名锚定时空 |`,
      `| ${shotNo++} | ${start + 3}-${start + 6}秒 | 情绪特写 | 【场景】${sceneTag} 【人物】${first} 【道具/物品】无；面部微表情与手部动作细节（须写清是谁） | 特写 | 固定镜头 | ${first}（情绪台词，按剧本填写） | 放大情绪，禁止再用「关键角色」等统称 |`,
      `| ${shotNo++} | ${start + 6}-${start + 9}秒 | 对峙/冲突镜头 | 【场景】${sceneTag} 【人物】${pair} 【道具/物品】无；同框构图与对峙关系（写清谁在画左/右） | 中景 | 轻微拉镜 | 对峙氛围+配乐推进 | 段落钩子，人物姓名必须与§3一致 |`
    );
  });

  return {
    storyboard: `## 短剧分镜脚本

| 序号 | 时长 | 镜头类型 | 镜头内容 | 景别 | 运镜方式 | 音效/台词 | 剪辑要点 |
|------|------|----------|----------|------|----------|-----------|----------|
${rows.join("\n")}`,
    sceneIndex,
  };
}

function sliceSkillText(skillText, startMarker) {
  if (!skillText) return "";
  const idx = skillText.indexOf(startMarker);
  if (idx < 0) return skillText;
  return skillText.slice(idx).trim();
}

function sliceSkillBetween(skillText, startMarker, endMarker) {
  if (!skillText) return "";
  const startIdx = skillText.indexOf(startMarker);
  if (startIdx < 0) return "";
  const endIdx = skillText.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx < 0) return skillText.slice(startIdx).trim();
  return skillText.slice(startIdx, endIdx).trim();
}

function findFirstJson(text) {
  if (!text) return null;
  // Try to extract the first {...} or [...] even if the model wraps it in fences.
  const fenceIdx = text.indexOf("```");
  if (fenceIdx >= 0) {
    // Prefer content inside fences
    const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m && m[1]) text = m[1];
  }

  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) return arrMatch[0];
  return null;
}

function parseJsonFromText(text, fallback) {
  const raw = findFirstJson(text);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 无 API 或 JSON 解析失败时的结构化兜底（与 script-analyzer 模板字段一致） */
function fallbackAnalysisJson(projectName, visualStyle, scriptText) {
  const p = (projectName || "").trim() || "未命名项目";
  const v = (visualStyle || "").trim() || "写实风，电影感";
  return {
    search_summary: {
      keywords: [p, "角色设定", "场景环境"],
      findings: "基于剧本文本做视觉补全（离线兜底）。",
    },
    style_suggestions: {
      visual_tone: v,
      color_palette: "冷暖对比",
      camera_language: "冲突段落推近与切镜",
    },
    characters: [
      {
        name: "主角A",
        aliases: [],
        demographics: { age_range: "青年", gender: "未知", occupation: "剧情核心角色" },
        personality_traits: ["情绪外显"],
        physical_description: "适合近景特写，神态细节明显",
        relationships: [],
        dialogue_stats: { total_lines: 0, total_words: 0, scenes_appears_in: [] },
        character_arc: { starting_state: "", major_changes: [], ending_state: "" },
        ai_image_prompt: {
          chinese_prompt: `${p}，主角A，${v}，服饰与神态细节`,
          english_enhancements: ["8k", "photorealistic"],
          example: `${p}，主角A，${v}，电影级打光，8k`,
        },
      },
    ],
    scenes: [
      {
        scene_id: "SCENE_1",
        scene_number: 1,
        location: { type: "INT/EXT", place: "核心场景", specific: "依据剧本构建空间与光影" },
        time: { time_of_day: "", chronology: "" },
        characters_present: [],
        summary: "关键冲突发生的空间",
        key_actions: [],
        key_dialogues: [],
        emotional_tone: "紧张",
        plot_significance: "",
        duration_estimate: "",
        props: [],
        atmosphere: v,
        ai_image_prompt: {
          chinese_prompt: `${p}，核心场景，${v}，关键环境特征`,
          visual_style: v,
          lighting: "电影感布光",
          example: `${p}，关键场景，${v}，叙事构图，8k`,
        },
      },
    ],
    relationship_summary: "角色关系随场景推进逐步揭示。",
    conclusion: "可进入分镜设计。",
  };
}

function characterIdentityLine(c) {
  if (!c || typeof c !== "object") return "（见剧本）";
  const parts = [];
  const d = c.demographics || {};
  if (d.occupation) parts.push(`定位：${d.occupation}`);
  if (d.age_range) parts.push(d.age_range);
  if (d.gender) parts.push(d.gender);
  if (Array.isArray(c.personality_traits) && c.personality_traits.length) {
    parts.push(`性格：${c.personality_traits.join("、")}`);
  }
  if (c.character_arc?.starting_state) parts.push(`起点：${c.character_arc.starting_state}`);
  if (Array.isArray(c.relationships) && c.relationships.length) {
    parts.push(
      c.relationships
        .map((r) => [r.type, r.to].filter(Boolean).join("→"))
        .filter(Boolean)
        .join("；")
    );
  }
  return parts.length ? parts.join("；") : "（见剧本与 JSON）";
}

/** script-analyzer §3 人物清单：与技能 Markdown 结构一致（供 UI 卡片正文） */
function characterIdentityForSkill(c, projectName) {
  const pName = (projectName || "").trim() || "（项目名）";
  const d = c.demographics || {};
  const name = String(c.name || "").trim() || "该角色";
  const bits = [];
  if (d.occupation) bits.push(`身份/职业：${d.occupation}`);
  if (d.age_range || d.gender) bits.push([d.age_range, d.gender].filter(Boolean).join("，"));
  if (Array.isArray(c.personality_traits) && c.personality_traits.length) {
    bits.push(`性格：${c.personality_traits.join("、")}`);
  }
  if (Array.isArray(c.relationships) && c.relationships.length) {
    bits.push(
      `关系：${c.relationships.map((r) => [r.type, r.to].filter(Boolean).join("→")).join("；")}`
    );
  }
  const arc = c.character_arc || {};
  if (arc.starting_state) bits.push(`剧情起点：${arc.starting_state}`);
  if (Array.isArray(arc.major_changes) && arc.major_changes.length) {
    bits.push(`关键变化：${arc.major_changes.join("；")}`);
  }
  if (arc.ending_state) bits.push(`剧情落点：${arc.ending_state}`);
  const st = c.dialogue_stats || {};
  const scn = Array.isArray(st.scenes_appears_in) ? st.scenes_appears_in.join("、") : "";
  if (st.total_lines != null || st.total_words != null || scn) {
    bits.push(
      `台词与出场：约 ${st.total_lines ?? "—"} 句 / ${st.total_words ?? "—"} 字${scn ? `；场景：${scn}` : ""}`
    );
  }
  if (Array.isArray(c.aliases) && c.aliases.length) bits.push(`别名：${c.aliases.join("、")}`);
  if (!bits.length) {
    return `（请依据剧本补充「${name}」在剧中的立场、功能与定位；项目：${pName}）`;
  }
  return bits.join("；");
}

/** 把模型误塞进 chinese_prompt 的技能模板拆掉，只保留可执行生图正文 */
function collapsePromptWhitespace(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractTaggedPromptSection(s) {
  const str = String(s || "");
  const stop = /(?=\n\s*-\s*\*\*示例\*\*|\*\*示例\*\*[：:]|$)/i;
  const m1 = str.match(new RegExp(`合成提示[：:]\\s*([\\s\\S]+?)${stop.source}`, "i"));
  if (m1 && m1[1] && collapsePromptWhitespace(m1[1]).length > 12) return m1[1].trim();
  const m2 = str.match(new RegExp(`中文提示[：:]\\s*([\\s\\S]+?)${stop.source}`, "i"));
  if (m2 && m2[1] && collapsePromptWhitespace(m2[1]).length > 12) return m2[1].trim();
  const m3 = str.match(/生图描述[：:]\s*([\s\S]+?)(?=\n\s*-\s*\*\*|$)/i);
  if (m3 && m3[1] && collapsePromptWhitespace(m3[1]).length > 12) return m3[1].trim();
  return "";
}

function extractExampleBacktickFromBlob(s) {
  const m = String(s).match(/\*\*示例\*\*[：:]\s*`([^`]+)`/);
  if (m) return m[1].trim();
  const m2 = String(s).match(/-\s*\*\*示例\*\*[：:]\s*`([^`]+)`/);
  if (m2) return m2[1].trim();
  return "";
}

function extractBiHanElementBody(s) {
  const m = String(s).match(/-\s*\*\*必含元素\*\*[：:]\s*([\s\S]+?)(?=\n\s*-\s*\*\*示例\*\*|$)/i);
  if (!m || !m[1]) return "";
  const inner = m[1].match(/合成提示[：:]\s*([\s\S]+?)(?=\n\s*-\s*\*\*示例\*\*|$)/is);
  if (inner && inner[1].trim().length > 12) return inner[1].trim();
  const t = m[1].trim();
  if (t.length > 40 && !/^\s*IP\/项目原名/.test(t)) return t;
  return "";
}

function sanitizeChineseImagePrompt(chineseRaw, exampleFieldFallback) {
  const raw = String(chineseRaw || "").trim();
  const exField = String(exampleFieldFallback || "").trim();

  let out = extractTaggedPromptSection(raw);
  if (out) return collapsePromptWhitespace(out);

  out = extractBiHanElementBody(raw);
  if (out) return collapsePromptWhitespace(out);

  out = extractExampleBacktickFromBlob(raw);
  if (out) return collapsePromptWhitespace(out);

  const stripped = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((t) => {
      if (!t) return false;
      if (/^-\s*\*\*语言要求\*\*/.test(t)) return false;
      if (/^-\s*\*\*必含元素\*\*/.test(t)) return false;
      if (/^-\s*\*\*示例\*\*/.test(t)) return false;
      if (/^\*\*语言要求\*\*/.test(t)) return false;
      if (/^\*\*必含元素\*\*/.test(t)) return false;
      if (/^\*\*示例\*\*/.test(t)) return false;
      return true;
    })
    .join(" ");
  if (collapsePromptWhitespace(stripped).length > 20) return collapsePromptWhitespace(stripped);

  if (exField) return collapsePromptWhitespace(exField);
  return collapsePromptWhitespace(raw);
}

function isAnimeLikeStyle(visualStyle) {
  const s = String(visualStyle || "").toLowerCase();
  return /动漫|二次元|2d|anime|manga|日漫|插画|cel[-\s]?shade|卡通/.test(s);
}

function stripConflictingStyleTerms(prompt, visualStyle) {
  const style = String(visualStyle || "").toLowerCase();
  let out = String(prompt || "");
  if (!out) return out;

  const allowsRealistic = /写实|photorealistic|\brealistic\b|真人/.test(style);
  const allowsFilmic = /电影|cinematic|film/.test(style);

  if (!allowsRealistic) {
    const realisticTerms = [
      /写实(风格|质感|风)?/gi,
      /photorealistic/gi,
      /\brealistic\b/gi,
      /真人(质感|写实|风格)?/gi,
      /真实(质感|风格)?/gi,
    ];
    for (const re of realisticTerms) out = out.replace(re, "");
  }
  if (!allowsFilmic) {
    const filmicTerms = [
      /电影级(镜头|打光|光影|构图)?/gi,
      /电影感(镜头|打光|光影|构图)?/gi,
      /cinematic/gi,
      /film[-\s]?look/gi,
      /35mm lens look/gi,
      /film grain/gi,
    ];
    for (const re of filmicTerms) out = out.replace(re, "");
  }

  return out.replace(/，\s*，+/g, "，").replace(/\s{2,}/g, " ").replace(/[，,\s]+$/g, "");
}

/** 按用户视觉风格对 prompt 做最终约束，避免风格跑偏 */
function enforcePromptByVisualStyle(prompt, visualStyle) {
  const style = String(visualStyle || "").trim();
  let p = collapsePromptWhitespace(prompt || "");
  if (!p) return p;

  // 始终把项目视觉风格前置，保证模型风格锚点稳定。
  if (style && !p.includes(style)) {
    p = `${style}，${p}`;
  }

  // 若用户风格未要求写实/电影感，剔除常见冲突词，避免默认风格污染。
  p = stripConflictingStyleTerms(p, style);

  // 动漫/2D 风格时，剔除明显写实摄影词，避免和用户风格冲突。
  if (isAnimeLikeStyle(style)) {
    const banned = [
      /photorealistic/gi,
      /\brealistic\b/gi,
      /写实(风|质感)?/g,
      /真人(质感|写实|风格)?/g,
      /high detail skin texture/gi,
      /skin texture/gi,
      /film grain/gi,
      /35mm lens look/gi,
      /shallow depth of field/gi,
      /sharp focus on eyes/gi,
      /high dynamic range/gi,
    ];
    for (const re of banned) p = p.replace(re, "");
    p = p.replace(/，\s*，+/g, "，").replace(/\s{2,}/g, " ").replace(/[，,\s]+$/g, "");
  }
  return collapsePromptWhitespace(p);
}

/**
 * 合成「可直接复制去生图」的完整提示词（禁止为空）。
 * example 仅作缺省素材并入正文，不在 UI 中单列为「示例」。
 */
function buildCharacterImagePromptParagraph(c, projectName, visualStyle) {
  const pName = (projectName || "").trim() || "未命名项目";
  const vStyle = (visualStyle || "").trim() || "写实风，电影感";
  const name = String(c.name || "").trim() || "角色";
  const img = c.ai_image_prompt || {};
  const chinese = sanitizeChineseImagePrompt(img.chinese_prompt, img.example);
  const example = String(img.example || "").trim();
  const appearance = String(c.physical_description || "").trim();

  let core = chinese || example;
  if (!core) {
    core = [pName, name, appearance || "服饰、发型、武器与神态细节需结合剧本补全", vStyle].filter(Boolean).join("，");
  }
  return enforcePromptByVisualStyle(core.trim(), vStyle);
}

function buildSceneImagePromptParagraph(s, projectName, visualStyle, sceneLabel) {
  const pName = (projectName || "").trim() || "未命名项目";
  const vStyle = (visualStyle || "").trim() || "写实风，电影感";
  const loc = s.location || {};
  const sceneName = String(loc.place || sceneLabel || "本场景").trim();
  const img = s.ai_image_prompt || {};
  const cn = sanitizeChineseImagePrompt(img.chinese_prompt, img.example);
  const ex = String(img.example || "").trim();
  const lighting = String(img.lighting || "").trim();
  const vimg = String(img.visual_style || "").trim() || vStyle;
  const atmosphere = String(s.atmosphere || "").trim();
  const specific = String(loc.specific || "").trim();
  const summary = String(s.summary || "").trim();

  let core = cn || ex;
  if (!core) {
    const envBits = [sceneName, specific, atmosphere, summary].filter(Boolean);
    core = [pName, ...envBits, vimg, lighting || "电影感环境光"].join("，");
  } else {
    const addOn = [lighting, vimg].filter((x) => x && !core.includes(x));
    if (addOn.length) core = `${core}，${addOn.join("，")}`;
  }
  return enforcePromptByVisualStyle(core.trim(), vStyle);
}

function formatCharacterCardContent(c, projectName, visualStyle) {
  const pName = (projectName || "").trim() || "（项目名）";
  const vStyle = (visualStyle || "").trim() || "写实风";
  const roleLine = characterIdentityForSkill(c, pName);
  const appearance = String(c.physical_description || "").trim() || "（请依据剧本与检索结果补充外貌、服饰、武器与神态细节）";
  const imgPrompt = buildCharacterImagePromptParagraph(c, pName, vStyle);
  const promptIndented = imgPrompt
    .split("\n")
    .map((ln) => (ln.trim() ? `  ${ln.trim()}` : ""))
    .filter(Boolean)
    .join("\n");

  return [
    `**身份**：${roleLine}`,
    `- **外貌描述**：${appearance}`,
    `- **AI生图提示词 (Prompt)**：`,
    promptIndented || `  ${imgPrompt}`,
  ].join("\n");
}

function locationTypeChinese(loc) {
  const t = String(loc?.type || "").toUpperCase();
  if (/INT\.?\s*\/\s*EXT|INT\/EXT/i.test(t)) return "内景与外景结合（以剧本标注为准）";
  if (t.includes("INT")) return "室内（内景）";
  if (t.includes("EXT")) return "室外（外景）";
  return "室内 / 室外（依据剧本 INT./EXT. 判断）";
}

/** script-analyzer §4 场景清单：与技能 Markdown 结构一致 */
function sceneEnvironmentForSkill(s) {
  const loc = s.location || {};
  const tm = s.time || {};
  const lines = [];
  const head = [String(loc.place || "").trim(), String(loc.specific || "").trim()].filter(Boolean).join(" · ");
  if (head) lines.push(`空间：${head}`);
  if (tm.time_of_day || tm.chronology) {
    lines.push(`时间：${[tm.time_of_day, tm.chronology].filter(Boolean).join("；")}`);
  }
  if (s.atmosphere) lines.push(`光影与氛围：${s.atmosphere}`);
  if (s.summary) lines.push(`本场摘要：${s.summary}`);
  const acts = Array.isArray(s.key_actions) ? s.key_actions : [];
  if (acts.length) lines.push(`关键动作：${acts.join("；")}`);
  const dials = Array.isArray(s.key_dialogues) ? s.key_dialogues : [];
  if (dials.length) lines.push(`关键对白：${dials.join("；")}`);
  const props = Array.isArray(s.props) ? s.props : [];
  if (props.length) lines.push(`道具/陈设：${props.join("、")}`);
  const present = Array.isArray(s.characters_present) ? s.characters_present.join("、") : "";
  if (present) lines.push(`在场人物：${present}`);
  if (!lines.length) return "（请依据剧本补充空间布局、光影、陈设与人物站位）";
  return lines.join("\n");
}

function formatSceneCardContent(s, projectName, visualStyle, sceneLabel) {
  const pName = (projectName || "").trim() || "（项目名）";
  const vStyle = (visualStyle || "").trim() || "写实风";
  const loc = s.location || {};
  const typeLine = locationTypeChinese(loc);
  const env = sceneEnvironmentForSkill(s);
  const imgPrompt = buildSceneImagePromptParagraph(s, pName, vStyle, sceneLabel);
  const promptIndented = imgPrompt
    .split("\n")
    .map((ln) => (ln.trim() ? `  ${ln.trim()}` : ""))
    .filter(Boolean)
    .join("\n");

  return [
    `**场景类型**：${typeLine}。`,
    `- **环境描述**：${env}`,
    `- **AI生图提示词 (Prompt)**：`,
    promptIndented || `  ${imgPrompt}`,
  ].join("\n");
}

/**
 * 第二次调用 LLM：仅润色生图提示词。人物依据「外貌描述」；场景依据「场景类型 + 环境描述 + 必含说明」。
 * 结果写入各条目的 ai_image_prompt.chinese_prompt，供卡片「AI生图提示词」展示；身份/外貌/场景类型等保持阶段1原文不动。
 */
function buildScenePolishMustInclude(s, projectName, visualStyle, sceneLabel) {
  const pName = (projectName || "").trim() || "未命名项目";
  const vStyle = (visualStyle || "").trim() || "写实风，电影感";
  const loc = s.location || {};
  const place = String(loc.place || sceneLabel || "本场景").trim();
  return `须含项目/IP 原名「${pName}」；场景名「${place}」；关键环境、空间层次、材质与光影须写具体；整体与视觉风格偏好「${vStyle}」协调`;
}

function applyPolishedCharacterPrompts(characters, rows, visualStyle) {
  if (!Array.isArray(characters) || !Array.isArray(rows)) return;
  const vStyle = String(visualStyle || "").trim();
  const byName = new Map(rows.map((r) => [String(r.name || "").trim(), r]));
  characters.forEach((c, i) => {
    const name = String(c.name || "").trim();
    const row = (name && byName.get(name)) || rows[i];
    if (!row) return;
    const raw = String(row.image_prompt || row.prompt || "").trim();
    const prompt = enforcePromptByVisualStyle(sanitizeChineseImagePrompt(raw, ""), vStyle);
    if (!prompt) return;
    c.ai_image_prompt = typeof c.ai_image_prompt === "object" && c.ai_image_prompt ? c.ai_image_prompt : {};
    c.ai_image_prompt.chinese_prompt = prompt;
  });
}

function applyPolishedScenePrompts(scenes, rows, visualStyle) {
  if (!Array.isArray(scenes) || !Array.isArray(rows)) return;
  const vStyle = String(visualStyle || "").trim();
  const byNum = new Map();
  rows.forEach((r) => {
    const n = Number(r.scene_number);
    if (Number.isFinite(n)) byNum.set(n, r);
  });
  scenes.forEach((s, i) => {
    const rawN = s.scene_number != null ? Number(s.scene_number) : i + 1;
    const n = Number.isFinite(rawN) ? rawN : i + 1;
    const row = byNum.get(n) || rows[i];
    if (!row) return;
    const raw = String(row.image_prompt || row.prompt || "").trim();
    const prompt = enforcePromptByVisualStyle(sanitizeChineseImagePrompt(raw, ""), vStyle);
    if (!prompt) return;
    s.ai_image_prompt = typeof s.ai_image_prompt === "object" && s.ai_image_prompt ? s.ai_image_prompt : {};
    s.ai_image_prompt.chinese_prompt = prompt;
  });
}

async function polishAnalysisImagePromptsWithLlm(data, projectName, visualStyle, modelId) {
  if (!process.env.OPENAI_API_KEY) return data;
  if (String(process.env.DISABLE_IMAGE_PROMPT_POLISH || "").trim() === "1") return data;
  const pName = (projectName || "").trim() || "未命名项目";
  const vStyle = (visualStyle || "").trim() || "写实风，电影感";
  const chars = data.characters || [];
  const scns = data.scenes || [];
  if (!chars.length && !scns.length) return data;

  const character_inputs = chars.map((c) => ({
    name: String(c.name || "").trim(),
    physical_description: String(c.physical_description || "").trim(),
  }));

  const scene_inputs = scns.map((s, i) => {
    const rawN = s.scene_number != null ? Number(s.scene_number) : i + 1;
    const n = Number.isFinite(rawN) ? rawN : i + 1;
    const label = `场景${n}`;
    const loc = s.location || {};
    return {
      scene_number: n,
      scene_type: locationTypeChinese(loc),
      environment: sceneEnvironmentForSkill(s),
      must_include: buildScenePolishMustInclude(s, pName, vStyle, label),
    };
  });

  const system = [
    "你是 AI 生图提示词“润色器”，只输出可直接复制到文生图模型的提示词正文，不输出分析、解释、步骤。",
    "风格必须以输入的 visual_style 为最高优先级；不要默认写实/电影感，除非 visual_style 明确要求。",
    "",
    "【人物提示词规则】对每条 character：仅根据 name + physical_description 扩写润色。",
    "- 只输出提示词正文，不输出解释/步骤/代码块；不要用 Markdown 列表符号（不要出现以 - 或 * 开头的行）。",
    "- 必须严格按下方“提示词模板”的字段与顺序输出；字段名必须原样出现；允许换行。",
    "- 只写画面可见内容（发型/服装/体态/材质/配色/五官细节/可见标记），禁止剧情复述、台词、心理活动、能力设定、世界观讲解、镜头术语（景别、运镜）、抽象性格词。",
    "- 必须自然融入 project_name 与角色 name；“画风”字段必须体现 visual_style 的关键词。",
    "",
    "【提示词模板】（必须严格照抄结构并填充内容）：",
    "【<visual_style>】风格，真实感，电影质感，高清摄影，自然光影，细腻肤质，真实人物，请参考提供的图片中的人物外观、面部特征、发型、服装风格、体型等特点，超写实风格，严格参考人物形象，还原人物的美，没有纹身，没有装饰品",
    "角色设计参考图布局要求：",
    "1.主视觉区(上方)：以\u201c正面+侧面+背面\u201d三个核心视角为主体，直观呈现角色的整体身形、服饰搭配和标志性特征，是制作人员对人物\u201c整体造型\u201d的参考基础。",
    "2.补充信息区(左侧)：拆分出\u201c面部特写\u201d和\u201c配色板\u201d(明确毛发、服饰的色值)，补充主视角没覆盖的细节与色彩标准。",
    "3.局部细节区(底部)：用小模块单独展示关键部件的设计(配饰、点缀、关键身份识别元素)，把主视角里的\u201c模糊细节\u201d拆分为精准的制作参考，方便导演确认。",
    "4.全身照比例照(右侧)：使用黄金比例参考物和人物身高形成对比。",
    "衣着：写清上衣/下装/鞋靴的款式与层次、材质、主色+辅色+点缀色",
    "",
    "【提示词排版强指令】你在生成 image_prompt 时，绝对禁止将上方模板中的规则说明、目的解释（如“明确毛发色值”、“方便导演确认”、“直观呈现身形”等）原封不动抄入输出！你只需直接输出描写该人物具体细节的画面词！直接将具体颜色、衣服款式、五官特征填入对应版块即可。",
    "",
    "【场景提示词规则】对每条 scene：根据 scene_type + environment + must_include 生成“纯环境”场景提示词。",
    "- 只输出一段连续中文文字，禁止换行。",
    "- 字数：150-260 字。",
    "- 禁止出现人物/人形/剪影/手部/人群；只写环境空间。",
    "- 必须包含：视角/镜头位置；时间与光线（光源/方向/色温/阴影）；空间结构；关键陈设3-8个（材质+颜色+位置）；前景/中景/背景层次；色调总结。",
    "- 禁止抽象词，必须改成可画的物体、材质、光影与位置关系。",
    "- 必须满足 must_include 中的“须含”要求（尤其是项目名与场景名）。",
    "",
    "输出严格为一个 JSON 对象（不要代码块包裹），格式：",
    '{"character_prompts":[{"name":"与输入角色名一致","image_prompt":"单段字符串"}],"scene_prompts":[{"scene_number":1,"image_prompt":"单段字符串"}]}',
    "character_prompts 条数与输入 characters 一致、顺序一致；scene_prompts 条数与输入 scenes 一致，scene_number 与输入一致。",
    "【硬性】image_prompt 禁止出现「语言要求」「必含元素」「示例」等标签字样；禁止 Markdown（**、-、#、`）；禁止 JSON 嵌套。",
  ].join("\n");

  const userPayload = JSON.stringify({
    project_name: pName,
    visual_style: vStyle,
    characters: character_inputs,
    scenes: scene_inputs,
  });

  let text;
  try {
    text = await callLlm(
      [{ role: "system", content: system }, { role: "user", content: userPayload }],
      modelId,
      { temperature: 0.65 }
    );
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/\b429\b/.test(msg)) {
      console.warn("polishAnalysisImagePromptsWithLlm: upstream busy (429), skip polish for this run");
      data.__warnings = Array.isArray(data.__warnings) ? data.__warnings : [];
      data.__warnings.push({
        code: "UPSTREAM_BUSY_429",
        message: "上游负载已饱和（429），本次已跳过“提示词润色”。建议在【设置】中切换模型后重试。",
      });
    } else {
      console.error("polishAnalysisImagePromptsWithLlm:", e.message || e);
    }
    return data;
  }
  if (!text) return data;
  const parsed = parseJsonFromText(text, null);
  if (!parsed || typeof parsed !== "object") return data;

  if (Array.isArray(parsed.character_prompts) && parsed.character_prompts.length) {
    applyPolishedCharacterPrompts(chars, parsed.character_prompts, vStyle);
  }
  if (Array.isArray(parsed.scene_prompts) && parsed.scene_prompts.length) {
    applyPolishedScenePrompts(scns, parsed.scene_prompts, vStyle);
  }
  // 二次校正：把当前 visual_style 强制写回每条 prompt。
  for (const c of chars) {
    const img = c.ai_image_prompt || {};
    if (img.chinese_prompt) {
      img.chinese_prompt = enforcePromptByVisualStyle(img.chinese_prompt, vStyle);
    }
  }
  for (const s of scns) {
    const img = s.ai_image_prompt || {};
    if (img.chinese_prompt) {
      img.chinese_prompt = enforcePromptByVisualStyle(img.chinese_prompt, vStyle);
    }
  }
  return data;
}

/** 把 analysisJson 里已写入的 chinese_prompt 统一清洗为单段可执行正文（便于落盘与下游使用） */
function normalizeStoredImagePromptsInAnalysis(data, visualStyle) {
  const vStyle = String(visualStyle || "").trim();
  for (const c of data.characters || []) {
    const img = c.ai_image_prompt;
    if (!img || typeof img !== "object") continue;
    const clean = sanitizeChineseImagePrompt(img.chinese_prompt, img.example);
    if (clean) img.chinese_prompt = enforcePromptByVisualStyle(clean, vStyle);
  }
  for (const s of data.scenes || []) {
    const img = s.ai_image_prompt;
    if (!img || typeof img !== "object") continue;
    const clean = sanitizeChineseImagePrompt(img.chinese_prompt, img.example);
    if (clean) img.chinese_prompt = enforcePromptByVisualStyle(clean, vStyle);
  }
}

function buildCharacterCardsFromJson(characters, projectName, visualStyle) {
  if (!Array.isArray(characters)) return [];
  const pName = (projectName || "").trim() || "项目";
  const vStyle = (visualStyle || "").trim() || "写实风";
  return characters.map((c, i) => {
    const title = String(c.name || "").trim() || `未命名角色${i + 1}`;
    return { title, content: formatCharacterCardContent(c, pName, vStyle) };
  });
}

function buildSceneCardsFromJson(scenes, projectName, visualStyle) {
  if (!Array.isArray(scenes)) return [];
  const pName = (projectName || "").trim() || "项目";
  const vStyle = (visualStyle || "").trim() || "写实风";
  return scenes.map((s, i) => {
    const rawN = s.scene_number != null ? Number(s.scene_number) : i + 1;
    const n = Number.isFinite(rawN) ? rawN : i + 1;
    const title = `场景${n}`;
    return { title, content: formatSceneCardContent(s, pName, vStyle, title) };
  });
}

/** 由 JSON characters[] 生成 Markdown（script-analyzer §3），与 characterCards 内容一致 */
function formatCharactersMdFromJson(characters, projectName, visualStyle) {
  if (!Array.isArray(characters) || characters.length === 0) return "";
  const cards = buildCharacterCardsFromJson(characters, projectName, visualStyle);
  return cards
    .map((c) => {
      const body = c.content
        .split("\n")
        .map((ln) => (ln.trim() ? `  ${ln}` : ""))
        .filter(Boolean)
        .join("\n");
      return `- **${c.title}**\n${body}`;
    })
    .join("\n\n");
}

/** 由 JSON scenes[] 生成 Markdown（script-analyzer §4） */
function formatScenesMdFromJson(scenes, projectName, visualStyle) {
  if (!Array.isArray(scenes) || scenes.length === 0) return "";
  const cards = buildSceneCardsFromJson(scenes, projectName, visualStyle);
  return cards
    .map((c) => {
      const body = c.content
        .split("\n")
        .map((ln) => (ln.trim() ? `  ${ln}` : ""))
        .filter(Boolean)
        .join("\n");
      return `- **${c.title}**\n${body}`;
    })
    .join("\n\n");
}

function markdownReportFromAnalysisJson(j, projectName, visualStyle) {
  const pName = (projectName || "").trim() || "项目";
  const vStyle = (visualStyle || "").trim() || "写实风";
  const ss = j.search_summary || {};
  const st = j.style_suggestions || {};
  const ch = formatCharactersMdFromJson(j.characters || [], pName, vStyle);
  const sc = formatScenesMdFromJson(j.scenes || [], pName, vStyle);
  return [
    "## 1. 关键设定检索结果",
    `- **搜索关键词**：${(ss.keywords || []).join("；") || pName + " 角色 场景"}`,
    `- **核心发现**：${ss.findings || "见下方 JSON 结构化人物与场景"}`,
    "",
    "## 2. 整体风格建议",
    `- **视觉基调**：${st.visual_tone || vStyle}`,
    `- **色调建议**：${st.color_palette || ""}`,
    `- **镜头语言**：${st.camera_language || ""}`,
    "",
    "## 3. 人物清单",
    ch || "（无）",
    "",
    "## 4. 场景清单",
    sc || "（无）",
    "",
    "## 5. 人物与场景关系图",
    j.relationship_summary || "",
    "",
    "## 6. 总结",
    j.conclusion || "",
  ].join("\n");
}

function isValidStage1Json(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    Array.isArray(obj.characters) &&
    Array.isArray(obj.scenes)
  );
}

/**
 * 阶段1：要求模型只输出 JSON（Character / Scene Profile 模板），再程序化生成 Markdown。
 */
async function runStage1Analysis({ projectName, visualStyle, scriptText, modelId }) {
  const pName = (projectName || "").trim() || "未命名项目";
  const vStyle = (visualStyle || "").trim() || "写实风，电影感";
  const script = scriptText || "";
  const scriptTrimPrimary = script.length > 12000 ? script.slice(0, 12000) : script;
  const scriptTrimSecondary = script.length > 8000 ? script.slice(0, 8000) : scriptTrimPrimary;

  const analyzerSkill = safeRead(SKILLS.analyzer);
  const directorSkill = safeRead(SKILLS.director);
  const directorPhase1 = sliceSkillBetween(directorSkill, "### 阶段1：剧本分析", "### 阶段2：分镜设计");
  const charTpl = sliceSkillBetween(analyzerSkill, "### Character Profile Template", "### Scene Profile Template");
  const sceneTpl = sliceSkillBetween(analyzerSkill, "### Scene Profile Template", "### Scene Transitions");
  const templateRef = [charTpl, sceneTpl].filter(Boolean).join("\n\n---\n\n") || analyzerSkill.slice(0, 10000);

  const systemPromptPrimary = [
    "你是剧本分析引擎，执行 script-analyzer 阶段1。输出必须是【单个 JSON 对象】，不要用 Markdown 标题报告，不要用 ``` 代码块包裹（如需围栏则仅包一层 json）。",
    "顶层结构：",
    "{",
    '  "search_summary": { "keywords": string[], "findings": string },',
    '  "style_suggestions": { "visual_tone": string, "color_palette": string, "camera_language": string },',
    '  "characters": [ CharacterProfile ... ],',
    '  "scenes": [ SceneProfile ... ],',
    '  "relationship_summary": string,',
    '  "conclusion": string',
    "}",
    "CharacterProfile 字段必须与技能中「Character Profile Template」JSON 一致：name, aliases, demographics, personality_traits, physical_description, relationships, dialogue_stats, character_arc, ai_image_prompt{ chinese_prompt, english_enhancements, example }。",
    "SceneProfile 字段必须与「Scene Profile Template」JSON 一致：scene_id, scene_number, location{type,place,specific}, time, characters_present, summary, key_actions, key_dialogues, emotional_tone, plot_significance, duration_estimate, props, atmosphere, ai_image_prompt{ chinese_prompt, visual_style, lighting, example }。",
    "characters[].name 必须是剧本中的角色姓名或称谓（禁止用「项目名」「类型/题材」「核心冲突」等元信息当作角色名）。",
    "scenes 按戏剧场次拆分，scene_number 从 1 递增；同一地点若多节拍可拆成多条并区分 summary。",
    "【场景命名强制】每个 scenes[].location.place 必须是“具体可拍地点名”，建议用「地点·时段」格式（如「宁府书房·深夜」「公司会议室·午后」）。禁止只写「室内/室外」「核心场景」「某处」「场景1」。",
    "【人物一致性】scenes[].characters_present 必须只从 characters[].name 中选取，不要临时造新名字；若是路人，用“路人甲/店员/侍卫”等并加入 characters。",
    "【人物提取强制要求】characters 数组必须【全面、完整、无遗漏】地提取本章原文中出现的*所有*具体人物（包括主角、配角、反派、哪怕是只出现一次的丫鬟/小兵/路人甲等，只要在场均需列出！绝不可省略漏提）；scenes 覆盖本章关键空间/场次。禁止在 JSON 外输出解释文字。",
    "【极速提取模式·减负指令】为了极大加快处理速度并防止你在长文本遗漏角色，你在输出 characters 和 scenes 数组时，必须将所有 ai_image_prompt 中的子字段（chinese_prompt等）全部设为空字符串 \"\"！请将全部算力聚焦在准确、无遗漏地提取出每一个人物的基础设定上！",
    "=== 模板原文（字段名与嵌套须一致）===",
    templateRef.slice(0, 9000),
  ].join("\n");

  const systemPromptSecondary = [
    systemPromptPrimary,
    "【降级要求】若你发现输入太长导致超时，请优先保证 JSON 字段完整性与可解析性，scene_number 递增即可。",
  ].join("\n");

  const userPromptPrimary = `项目名：${pName}\n视觉风格偏好：${vStyle}\n\n请阅读剧本，输出完整 JSON。\n\n剧本：\n${scriptTrimPrimary}`;
  const userPromptSecondary = `项目名：${pName}\n视觉风格偏好：${vStyle}\n\n请阅读剧本，输出完整 JSON。\n\n剧本：\n${scriptTrimSecondary}`;

  let llmText = null;
  try {
    llmText = await callLlm(
      [{ role: "system", content: systemPromptPrimary }, { role: "user", content: userPromptPrimary }],
      modelId
    );
  } catch (err) {
    // 例如上游 524/超时：重试一次更短的 prompt，尽量让第一步可完成
    try {
      llmText = await callLlm(
        [{ role: "system", content: systemPromptSecondary }, { role: "user", content: userPromptSecondary }],
        modelId,
        { temperature: 0.3 }
      );
    } catch {
      llmText = null;
    }
  }

  let data = llmText ? parseJsonFromText(llmText, null) : null;
  if (!isValidStage1Json(data)) {
    data = fallbackAnalysisJson(pName, vStyle, script);
  } else if ((data.characters?.length || 0) === 0 && (data.scenes?.length || 0) === 0) {
    data = fallbackAnalysisJson(pName, vStyle, script);
  }

  await polishAnalysisImagePromptsWithLlm(data, pName, vStyle, modelId);
  normalizeStoredImagePromptsInAnalysis(data, vStyle);

  const charactersMd = formatCharactersMdFromJson(data.characters, pName, vStyle);
  const scenesMd = formatScenesMdFromJson(data.scenes, pName, vStyle);
  const rawAnalysisMd = markdownReportFromAnalysisJson(data, pName, vStyle);
  const characterCards = buildCharacterCardsFromJson(data.characters, pName, vStyle);
  const sceneCards = buildSceneCardsFromJson(data.scenes, pName, vStyle);

  return { analysisJson: data, rawAnalysisMd, charactersMd, scenesMd, characterCards, sceneCards };
}

function getOpenAiFallbackModelId() {
  return String(process.env.OPENAI_FALLBACK_MODEL || "gpt-5.4-mini").trim();
}

function isUpstreamModelRoutingFailure(status, detailText) {
  const raw = String(detailText || "");
  let code = "";
  let msg = raw.toLowerCase();
  try {
    const j = JSON.parse(raw);
    const err = j?.error || j;
    code = String(err?.code || j?.code || "").toLowerCase();
    msg = String(err?.message || j?.message || raw).toLowerCase();
  } catch {
    // keep msg from raw
  }
  if (code === "model_not_found") return true;
  if (msg.includes("model_not_found")) return true;
  if (msg.includes("no available channel")) return true;
  if (msg.includes("invalid_model")) return true;
  if ((status === 404 || status === 400 || status === 503) && msg.includes("model") && (msg.includes("not found") || msg.includes("不存在") || msg.includes("unsupported"))) {
    return true;
  }
  return false;
}

async function callLlm(messages, modelIdOverride, options) {
  const ctxUserId = requestContext.getStore()?.userId || null;
  const optUserId = options && options.userId ? String(options.userId) : null;
  const billingUserId = optUserId || ctxUserId;

  // Resolve the channel config: custom oioiapi or built-in Xflow
  let textConfig = options?.textConfig || null;
  if (!textConfig && billingUserId) {
    const billingUser = await findUserById(billingUserId).catch(() => null);
    textConfig = billingUser ? resolveUserTextConfig(billingUser) : null;
  }
  const key  = textConfig?.apiKey  || process.env.OPENAI_API_KEY;
  const base = textConfig?.baseUrl || String(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/g, "");
  const skipBilling = textConfig?.skipBilling || false;

  if (!key) return null;

  if (!skipBilling) {
    await assertUserHasPoints(billingUserId);
  }

  // For custom channel, use the config modelId; otherwise honour modelIdOverride
  const requestedModel = textConfig?.isCustom
    ? textConfig.modelId
    : (modelIdOverride || process.env.OPENAI_MODEL || "qwen3-max");
  // Disable fallback for custom channel to avoid silently switching providers
  const fallbackModel = (options?.skipModelFallback || textConfig?.isCustom) ? "" : getOpenAiFallbackModelId();
  let activeModel = requestedModel;
  let switchedToFallback = false;
  const url = /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const temperature = options && typeof options.temperature === "number" ? options.temperature : 0.4;
  const maxAttempts = Number.isFinite(Number(options?.maxAttempts))
    ? Math.max(1, Number(options.maxAttempts))
    : 3;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let resp;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "User-Agent": "Xflow-OpenAI-Compatible/1.0",
          },
          body: JSON.stringify({
            model: activeModel,
            temperature,
            messages,
          }),
        });
      } catch (netErr) {
        throw new Error(formatUpstreamTextFetchError(netErr, url));
      }

      if (!resp.ok) {
        const detail = await resp.text();
        const routeFail = isUpstreamModelRoutingFailure(resp.status, detail);
        if (
          routeFail &&
          !switchedToFallback &&
          fallbackModel &&
          activeModel === requestedModel &&
          fallbackModel !== requestedModel
        ) {
          switchedToFallback = true;
          activeModel = fallbackModel;
          attempt -= 1;
          continue;
        }
        const err = new Error(`LLM调用失败: ${resp.status} ${detail}`);
        const retryableStatus = (resp.status >= 500 || resp.status === 429) && !routeFail;
        if (attempt < maxAttempts && retryableStatus) {
          const baseDelay = resp.status === 429 ? 2000 : 900;
          const jitter = Math.floor(Math.random() * 600);
          await new Promise((r) => setTimeout(r, attempt * baseDelay + jitter));
          continue;
        }
        throw err;
      }

      const data = await resp.json();
      if (data?.usage) {
        if (!skipBilling) {
          await recordUserUsageAndDeductPoints(billingUserId, data.usage, activeModel);
        } else {
          // Record external usage trace without deducting points
          await recordExternalUsageTrace(billingUserId, { provider: "oioiapi", modelId: activeModel }).catch(() => {});
        }
      }
      return data.choices?.[0]?.message?.content || null;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const baseDelay = /429/.test(String(err?.message || "")) ? 2000 : 900;
      const jitter = Math.floor(Math.random() * 600);
      await new Promise((r) => setTimeout(r, attempt * baseDelay + jitter));
    }
  }

  throw lastErr || new Error("LLM调用失败: 未知错误");
}

async function recordExternalUsageTrace(userId, { provider, modelId }) {
  if (!userId) return;
  const user = await findUserById(userId);
  if (!user) return;
  const at = new Date().toISOString();
  user.lastUsage = { type: "usage_external", provider: provider || "oioiapi", modelId: modelId || "", at };
  await saveUser(user);
}

async function callLlmStream({ messages, model, temperature, apiKey, url }) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "Xflow-OpenAI-Compatible/1.0",
      },
      body: JSON.stringify({
        model,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        messages,
      }),
    });
  } catch (netErr) {
    throw new Error(formatUpstreamTextFetchError(netErr, url));
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`LLM流式调用失败: ${resp.status} ${detail}`);
  }
  if (!resp.body) throw new Error("LLM流式调用失败: empty body");
  return resp.body;
}

async function callLlmStreamWithOptionalModelFallback({ messages, requestedModel, temperature, apiKey, url }) {
  const fallbackModel = getOpenAiFallbackModelId();
  let model = requestedModel;
  let triedFallback = false;
  for (; ;) {
    try {
      const body = await callLlmStream({ messages, model, temperature, apiKey, url });
      return { body, model };
    } catch (err) {
      const msg = String(err?.message || "");
      const m = msg.match(/LLM流式调用失败:\s*(\d+)\s+([\s\S]*)$/);
      const status = m ? Number(m[1]) : 0;
      const detail = m ? m[2] : msg;
      if (
        !triedFallback &&
        fallbackModel &&
        requestedModel !== fallbackModel &&
        model === requestedModel &&
        isUpstreamModelRoutingFailure(status, detail)
      ) {
        triedFallback = true;
        model = fallbackModel;
        continue;
      }
      throw err;
    }
  }
}

function writeSse(res, dataObj) {
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function parseSseLinesToJsonChunks(text) {
  // Upstream SSE contains lines like: "data: {...}\n\n" and terminator "data: [DONE]"
  const out = [];
  const blocks = text.split("\n\n");
  for (const b of blocks) {
    const line = b.trim();
    if (!line) continue;
    const m = line.match(/^data:\s*(.+)$/m);
    if (!m) continue;
    const payload = (m[1] || "").trim();
    if (!payload) continue;
    if (payload === "[DONE]") out.push({ done: true });
    else out.push({ json: payload });
  }
  return out;
}

/** 兼容旧 pipeline：仅返回 Markdown 报告正文（由 JSON 程序化生成） */
async function runStage1(params) {
  const { projectName, visualStyle, scriptText, modelId } = params;
  const r = await runStage1Analysis({ projectName, visualStyle, scriptText, modelId });
  return r.rawAnalysisMd;
}

async function runStage2(params) {
  const { analysisText, scriptText, modelId, itemsMd, storylineMd } = params;
  const directorSkill = safeRead(SKILLS.director);
  const storyboardSkill = safeRead(SKILLS.storyboard);

  const systemPrompt = [
    "你是 ai-short-video-director，当前只执行阶段2，并严格参考技能规则。",
    "必须输出 JSON，格式为 {\"storyboard\":\"markdown文本\",\"scene_index\":[...]}。",
    "storyboard 必须是 8 字段 Markdown 表格（序号、时长、镜头类型、镜头内容、景别、运镜方式、音效/台词、剪辑要点）。",
    "【资产关联·强制】表格每一行的「镜头内容」列内，必须用简短前缀写清三部分（可与叙事连成一句，但三部分信息不可缺）：",
    "（1）【人物】须列出本镜头**真实姓名**（与 §3 人物清单完全一致）。禁止仅用「关键角色」「主角」「对方」「人物关系」等统称；群体镜头写全名如「宁宸、宁兴同框」。",
    "（2）【场景】须写 §4 场景清单中的**具体名称**（优先用「地点·时段」如「宁府书房·深夜」），禁止只写「场景1」「场景2」或「室内/室外」；若清单有场号可写「场3-宁府书房·夜」。",
    "（3）【道具/物品】本镜头画面中关键可见道具；无则写「无」。若提供物品清单，名称必须从清单中选取并保持一致。",
    "「镜头内容」在三个前缀之后，继续写动作、构图、表情等画面细节；信息要具体到可开拍。",
    "「音效/台词」列：对白须写「角色名：台词」；勿写笼统「关键台词」。",
    "禁止输出与模板示例雷同的敷衍行（如仅「空间关系建立」「人物关系同框对峙」而无姓名地名）。",
    "其它列（景别、运镜等）照常填写。",
    "=== director skill ===",
    directorSkill,
    "=== storyboard designer skill ===",
    storyboardSkill,
  ].join("\n");

  const blocks = [
    `剧本分析结果：\n${analysisText}`,
    String(itemsMd || "").trim() ? `辅助物品清单（大纲）：\n${String(itemsMd).trim()}` : "",
    String(storylineMd || "").trim()
      ? `故事线参考（可节选理解节拍）：\n${String(storylineMd).trim().slice(0, 6000)}`
      : "",
    `原始剧本：\n${scriptText}`,
  ].filter(Boolean);
  const userPrompt = blocks.join("\n\n");
  const llmText = await callLlm([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], modelId);

  if (llmText) {
    try {
      const parsed = JSON.parse(llmText);
      if (parsed.storyboard && Array.isArray(parsed.scene_index)) {
        return { storyboard: parsed.storyboard, sceneIndex: parsed.scene_index };
      }
    } catch {
      // fall back
    }
  }
  const fb = fallbackStoryboard(scriptText, analysisText);
  return { storyboard: fb.storyboard, sceneIndex: fb.sceneIndex };
}

async function runStage2Assets({ projectName, chapterText, analysisText, itemsMd, storylineMd, modelId }) {
  const result = await runStage2({
    analysisText,
    scriptText: chapterText,
    itemsMd,
    storylineMd,
    modelId,
  });
  return {
    storyboardJson: { scene_index: result.sceneIndex || [] },
    storyboardMd: result.storyboard || "",
  };
}

function outputPaths() {
  return {
    status: path.join(OUTPUT_ROOT, "status.json"),
    analysis: path.join(OUTPUT_ROOT, "analysis", "script_analysis.md"),
    storyboard: path.join(OUTPUT_ROOT, "storyboard", "storyboard.md"),
    sceneIndex: path.join(OUTPUT_ROOT, "storyboard", "scene_index.json"),
    report: path.join(OUTPUT_ROOT, "production_report.md"),
  };
}

function saveAllArtifacts(payload) {
  const paths = outputPaths();
  writeFile(paths.status, JSON.stringify(payload.status, null, 2));
  writeFile(paths.analysis, payload.analysisText || "");
  writeFile(paths.storyboard, payload.storyboardText || "");
  writeFile(paths.sceneIndex, JSON.stringify(payload.sceneIndex || [], null, 2));
  writeFile(paths.report, payload.reportText || "");
  return paths;
}

app.post("/api/pipeline/init", requireAuth, (req, res) => {
  ensureDir(OUTPUT_ROOT);
  const status = initStatusObj();
  const paths = saveAllArtifacts({
    status,
    analysisText: "",
    storyboardText: "",
    sceneIndex: [],
    reportText: "# 制作报告\n\n- 流程已初始化",
  });
  res.json({ status, paths });
});

app.post("/api/pipeline/stage1", requireAuth, async (req, res) => {
  try {
    const { projectName, visualStyle, scriptText, status } = req.body;
    const nextStatus = status || initStatusObj();
    nextStatus.todos[0].status = "in_progress";
    nextStatus.todos[1].status = "pending";

    const analysisText = await runStage1({ projectName, visualStyle, scriptText });
    nextStatus.todos[0].status = "completed";
    nextStatus.todos[1].status = "in_progress";

    const paths = saveAllArtifacts({
      status: nextStatus,
      analysisText,
      storyboardText: "",
      sceneIndex: [],
      reportText: `# 制作报告\n\n- 项目：${projectName}\n- 阶段1：已完成`,
    });
    res.json({ status: nextStatus, analysisText, paths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pipeline/stage2", requireAuth, async (req, res) => {
  try {
    const { projectName, scriptText, analysisText, status } = req.body;
    const nextStatus = status || initStatusObj();
    nextStatus.todos[0].status = "completed";
    nextStatus.todos[1].status = "in_progress";

    const stage2 = await runStage2({ analysisText, scriptText });
    nextStatus.todos[1].status = "completed";

    const paths = saveAllArtifacts({
      status: nextStatus,
      analysisText,
      storyboardText: stage2.storyboard,
      sceneIndex: stage2.sceneIndex,
      reportText: `# 制作报告\n\n- 项目：${projectName}\n- 阶段1：completed\n- 阶段2：completed`,
    });
    res.json({
      status: nextStatus,
      storyboardText: stage2.storyboard,
      sceneIndex: stage2.sceneIndex,
      paths,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pipeline/run-all", requireAuth, async (req, res) => {
  try {
    const { projectName, visualStyle, scriptText } = req.body;
    const status = initStatusObj();
    status.todos[0].status = "in_progress";
    const analysisText = await runStage1({ projectName, visualStyle, scriptText });
    status.todos[0].status = "completed";
    status.todos[1].status = "in_progress";
    const stage2 = await runStage2({ analysisText, scriptText });
    status.todos[1].status = "completed";

    const paths = saveAllArtifacts({
      status,
      analysisText,
      storyboardText: stage2.storyboard,
      sceneIndex: stage2.sceneIndex,
      reportText: `# 制作报告\n\n- 项目：${projectName}\n- 编排器：ai-short-video-director\n- 模块调用链：script-analyzer -> storyboard_designer`,
    });
    res.json({
      status,
      analysisText,
      storyboardText: stage2.storyboard,
      sceneIndex: stage2.sceneIndex,
      paths,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pipeline/save-edits", requireAuth, (req, res) => {
  try {
    const { projectName, status, analysisText, storyboardText, sceneIndex } = req.body;
    const paths = saveAllArtifacts({
      status: status || initStatusObj(),
      analysisText: analysisText || "",
      storyboardText: storyboardText || "",
      sceneIndex: sceneIndex || [],
      reportText: `# 制作报告\n\n- 项目：${projectName}\n- 操作：手动编辑保存`,
    });
    res.json({ ok: true, paths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/pipeline/assets", requireAuth, (_req, res) => {
  const paths = outputPaths();
  const assets = {
    "output/status.json": safeRead(paths.status),
    "output/analysis/script_analysis.md": safeRead(paths.analysis),
    "output/storyboard/storyboard.md": safeRead(paths.storyboard),
    "output/storyboard/scene_index.json": safeRead(paths.sceneIndex),
    "output/production_report.md": safeRead(paths.report),
  };
  res.json({ assets, files: Object.keys(assets) });
});

// -----------------------------
// Auth & Project isolation（用户与积分：SQLite users.sqlite，启动时从 users_index.json 一次性迁移）
// -----------------------------
function ensureUsersIndex() {
  ensureDir(OUTPUT_ROOT);
}

async function migrateUsersFromJson() {
  const candidates = [
    path.join(OUTPUT_ROOT, "users_index.json"),
    path.join(OUTPUT_ROOT, "users_index.json.migrated"),
  ];
  let migratedTotal = 0;
  for (const jsonPath of candidates) {
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const raw = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(raw);
      const users = Array.isArray(data?.users) ? data.users : [];
      for (const u of users) {
        if (!u.id || !u.phone) continue;
        const exists = await User.findOne({ id: u.id }).lean();
        if (exists) continue;
        const flat = { ...u };
        delete flat._id;
        delete flat.__v;
        await User.findOneAndUpdate({ id: u.id }, { $set: flat }, { upsert: true });
        migratedTotal++;
      }
    } catch (e) {
      console.error(`[MongoDB] User migration from ${path.basename(jsonPath)} failed:`, e?.message || e);
    }
  }
  if (migratedTotal > 0) {
    console.log(`[MongoDB] Migrated ${migratedTotal} user(s) from legacy JSON`);
  }
}

async function writeUsersIndexSnapshot() {
  try {
    const users = await User.find({}).lean();
    const out = { users: users.map((u) => flattenUser(u)).filter((u) => u && u.id) };
    fs.writeFileSync(path.join(OUTPUT_ROOT, "users_index.json"), JSON.stringify(out, null, 2), "utf-8");
  } catch (e) {
    console.error("[UsersIndex] Snapshot write failed:", e?.message || e);
  }
}

async function getUsersIndex() {
  const users = await User.find({}).lean();
  return { users: users.map(u => flattenUser(u)).filter(u => u && u.id) };
}

function flattenUser(u) {
  if (!u) return null;
  let current = u;
  // If we have a nested doc structure, keep unwrapping it
  // This heals the "doc: { doc: { ... } }" recursion
  while (current && current.doc && typeof current.doc === "object" && Object.keys(current.doc).length > 0) {
    const nested = current.doc;
    delete current.doc;
    current = { ...current, ...nested };
  }
  return current;
}

async function saveUser(user) {
  if (!user || !user.id || !user.phone) return;
  const flat = flattenUser(user);
  const id = flat.id;
  delete flat._id;
  delete flat.__v;
  // Make sure we don't save the 'doc' field anymore unless as a cleanup
  delete flat.doc;
  
  await User.findOneAndUpdate(
    { id },
    { $set: flat },
    { upsert: true, new: true }
  );
  await writeUsersIndexSnapshot();
}

async function findUserById(userId) {
  if (!userId) return null;
  const u = await User.findOne({ id: userId }).lean();
  return u ? flattenUser(u) : null;
}

async function findUserByPhone(phone) {
  const n = String(phone || "").trim();
  if (!n) return null;
  const u = await User.findOne({ phone: n }).lean();
  return u ? flattenUser(u) : null;
}

const PROJECTS_DIR = path.join(OUTPUT_ROOT, "projects");

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function projectsDir(userId) {
  return path.join(PROJECTS_DIR, userId);
}

function projectIndexPath(userId) {
  return path.join(projectsDir(userId), "projects_index.json");
}

function projectDir(userId, projectId) {
  return path.join(projectsDir(userId), projectId);
}

function projectSettingsPath(userId, projectId) {
  return path.join(projectDir(userId, projectId), "project.json");
}

function novelDir(userId, projectId) {
  return path.join(projectDir(userId, projectId), "novel");
}

function novelChaptersPath(userId, projectId) {
  return path.join(novelDir(userId, projectId), "chapters.json");
}

function chapterDir(userId, projectId, chapterId) {
  return path.join(projectDir(userId, projectId), "chapters", chapterId);
}

function chapterTextPath(userId, projectId, chapterId) {
  return path.join(chapterDir(userId, projectId, chapterId), "chapter.txt");
}

function outlinePath(userId, projectId, chapterId) {
  return path.join(chapterDir(userId, projectId, chapterId), "outline.json");
}

function assetsPath(userId, projectId, chapterId) {
  return path.join(chapterDir(userId, projectId, chapterId), "assets.json");
}

// ---- Project-level asset library helpers (cross-chapter image reuse) ----

function normalizeProjectAssetName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function projectAssetDir(userId, projectId, moduleType) {
  return path.join(projectDir(userId, projectId), "project-assets", moduleType);
}

async function findProjectAsset(userId, projectId, moduleType, name) {
  const normalizedName = normalizeProjectAssetName(name);
  if (!normalizedName) return null;
  return ProjectAsset.findOne({ userId, projectId, moduleType, normalizedName }).lean();
}

async function upsertProjectAsset({ userId, projectId, moduleType, name, prompt, image }) {
  const normalizedName = normalizeProjectAssetName(name);
  if (!normalizedName || !image) return;
  await ProjectAsset.findOneAndUpdate(
    { userId, projectId, moduleType, normalizedName },
    {
      $set: { name: String(name || "").trim(), prompt: String(prompt || "") },
      $push: { images: { $each: [image], $position: 0, $slice: 12 } },
    },
    { upsert: true, new: true }
  );
}

function absPathFromPublicUrl(publicUrl) {
  const rel = String(publicUrl || "").replace(/^\/+/, "");
  if (!rel) return "";
  return path.join(__dirname, rel.split("/").join(path.sep));
}

function projectAssetImageExistsByUrl(publicUrl) {
  const absPath = absPathFromPublicUrl(publicUrl);
  if (!absPath) return false;
  return fs.existsSync(absPath);
}

// ---- end project-level asset library helpers ----

function outlineHasValidAnalysisMd(outline) {
  return Boolean(
    outline && typeof outline.rawAnalysisMd === "string" && outline.rawAnalysisMd.trim().length > 0
  );
}

function ensureProjectIndex(userId) {
  ensureDir(OUTPUT_ROOT);
  ensureDir(PROJECTS_DIR);
  ensureDir(projectsDir(userId));
  const p = projectIndexPath(userId);
  if (!fs.existsSync(p)) writeJson(p, { projects: [] });
}

function newProjectId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeSlugName(name) {
  return (name || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 60);
}


// MongoDB IO Helpers for Projects/Chapters/Assets

function splitIntoChapters_legacyDuplicate(novelText) {
  const text = (novelText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  // 拆章锚点：
  // - 支持：第1章/第一章/第 1 集/第一集/第1话/第1幕/第1卷/第1回/第1篇/第1部/第1册/第1辑...
  // - 支持包裹符号与常见后缀： 【】 () （） : ： - —— 等
  // - 兼容“序章/楔子/引子/序/尾声/后记/番外”等独立章节标题
  // 说明：与下方 strip 正则保持同步
  const marker = "章节回卷集话篇部幕册辑";
  const chapterNum = "(?:[0-9]+|[零一二三四五六七八九十百千万两]+)";
  const headCore = `第\\s*${chapterNum}\\s*[${marker}]`;
  const headWrapped = `(?:[【\\[(（]\\s*)?(?:${headCore})(?:\\s*[】\\])）])?`;
  const headTail = `(?:\\s*[：:、,，\\-—–].*)?`;
  const specialHead = "(?:序章|楔子|引子|序|尾声|后记|番外)(?:\\s*[：:、,，\\-—–].*)?";
  const chapterHeadLine = `(?:${headWrapped}${headTail}|${specialHead})`;
  const chapterRegex = new RegExp(`(^|\\n)\\s*(${chapterHeadLine})\\s*(?=\\n)`, "gi");
  const stripChapterHeadRe = new RegExp(`^\\s*(${chapterHeadLine})\\s*\\n?`, "i");

  const matches = [];
  let m;
  while ((m = chapterRegex.exec(text))) {
    const idx = m.index + (m[1] === "\n" ? 1 : 0);
    const heading = String(m[2] || "").trim();
    matches.push({ index: idx, title: heading || `第${matches.length + 1}章` });
  }

  if (matches.length === 0) {
    // fallback: split by long blank lines
    const parts = text
      .split(/\n{3,}/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length <= 1) {
      const smart = smartSplitNoMarkers(text);
      if (smart.length) return smart;
      return [{ title: "第一章", content: text, _autoTitle: true }];
    }
    return parts.map((content, i) => ({ title: `第${i + 1}章`, content, _autoTitle: true }));
  }

  matches.sort((a, b) => a.index - b.index);
  const chapters = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const chapterContent = text.slice(start, end).replace(stripChapterHeadRe, "").trim();
    chapters.push({
      title: (matches[i].title || "").replace(/\s+/g, " ").trim() || `第${i + 1}章`,
      content: chapterContent || "",
    });
  }
  return chapters;
}

function smartSplitNoMarkers(rawText) {
  const text = String(rawText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const TARGET_MIN = 2500;
  const TARGET_MAX = 4500;
  const HARD_MIN = 1200;
  const HARD_MAX = 6500;

  const paragraphs = text
    .split(/\n{2,}/g)
    .map((p) => p.replace(/\n+/g, "\n").trim())
    .filter(Boolean);

  // If no blank lines at all, fallback to splitting by sentence-ish boundaries.
  const units =
    paragraphs.length > 1
      ? paragraphs
      : text
        .split(/(?<=[。！？!?])\s*\n+/g)
        .map((s) => s.trim())
        .filter(Boolean);

  if (!units.length) return [];

  const boundaryRe = [
    { re: /(次日|翌日|第二天|隔天|三天后|数日后|半月后|一月后|多年后|不久后|片刻后)/, w: 4 },
    { re: /(与此同时|同一时间|另一边|另一头|转眼间|忽然|忽而|忽地)/, w: 2 },
    { re: /(回到|来到|走进|进入|离开|抵达|赶到|回府|回宫|回家|回营|入城|出城)/, w: 2 },
    { re: /(随后|最终|至此|于是|结果|终究|散去|落幕|告一段落)/, w: 1 },
    { re: /(——|—{2,})/, w: 2 },
  ];

  function unitScore(u) {
    const s = String(u || "");
    let score = 0;
    for (const it of boundaryRe) if (it.re.test(s)) score += it.w;
    // Prefer boundaries that end with strong punctuation.
    if (/[。！？!?]$/.test(s)) score += 1;
    return score;
  }

  const res = [];
  let buf = [];
  let bufLen = 0;

  function flush(force) {
    const content = buf.join("\n\n").trim();
    if (!content) return;
    if (!force && content.length < HARD_MIN) return;
    res.push({ title: `第${res.length + 1}章`, content, _autoTitle: true });
    buf = [];
    bufLen = 0;
  }

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const uLen = u.length;

    // If current buffer is already too large, cut immediately.
    if (bufLen >= HARD_MAX) {
      flush(true);
    }

    buf.push(u);
    bufLen += uLen + 2;

    if (bufLen < HARD_MIN) continue;

    // Lookahead: decide whether to cut here.
    const nearTarget = bufLen >= TARGET_MIN && bufLen <= TARGET_MAX;
    const overTarget = bufLen > TARGET_MAX;
    if (!nearTarget && !overTarget) continue;

    const s = u;
    const score = unitScore(s);

    // Cut rules:
    // - If near target and score indicates a likely boundary, cut.
    // - If over target, cut even with low score, but slightly prefer better boundaries.
    if ((nearTarget && score >= 2) || (overTarget && (score >= 1 || bufLen >= HARD_MAX - 200))) {
      flush(true);
    }
  }

  if (buf.length) flush(true);

  // Merge too-short tail into previous.
  if (res.length >= 2) {
    const last = res[res.length - 1];
    if ((last.content || "").length < HARD_MIN) {
      res[res.length - 2].content = `${res[res.length - 2].content}\n\n${last.content}`.trim();
      res.pop();
    }
  }

  // Re-title after merges.
  return res.map((c, idx) => ({ title: `第${idx + 1}章`, content: c.content || "" }));
}

function extractSectionBlock_legacyDuplicate(markdown, headingText) {
  // headingText should be like "### 3. 人物清单" or "### 4. 场景清单"
  const startIdx = markdown.indexOf(headingText);
  if (startIdx < 0) return "";
  const rest = markdown.slice(startIdx + headingText.length);

  const nextHeadingMatch = rest.match(/\n###\s*\d+\.?\s*.+\n/g);
  if (nextHeadingMatch && nextHeadingMatch.index >= 0) {
    return (headingText + rest.slice(0, nextHeadingMatch.index)).trim();
  }
  return (headingText + rest).trim();
}

/** 从整份分析报告中截取「人物清单」与「场景清单」，避免两者都回退成全文导致内容相同 */
function extractSectionBetween_legacyDuplicate(markdown, startMarkers, endMarkers) {
  if (!markdown) return "";
  let bestStart = -1;
  let bestMarker = "";
  for (const m of startMarkers) {
    const i = markdown.indexOf(m);
    if (i >= 0 && (bestStart < 0 || i < bestStart)) {
      bestStart = i;
      bestMarker = m;
    }
  }
  if (bestStart < 0) return "";
  const rest = markdown.slice(bestStart + bestMarker.length);
  let cut = rest.length;
  for (const end of endMarkers) {
    const j = rest.indexOf(end);
    if (j >= 0 && j < cut) cut = j;
  }
  return (bestMarker + rest.slice(0, cut)).trim();
}

function extractCharactersSection_legacyDuplicate(analysisText) {
  const starts = [
    "### 3. 人物清单",
    "### 人物清单",
    "## 3. 人物清单",
    "## 人物清单",
    "#### 3. 人物清单",
  ];
  const ends = [
    "\n### 4. 场景清单",
    "\n### 4.",
    "\n### 场景清单",
    "\n## 4. 场景清单",
    "\n## 4.",
    "\n### 5.",
    "\n### 5. 人物与场景关系图",
    "\n## 5.",
  ];
  let s = extractSectionBetween(analysisText, starts, ends);
  if (s) return s;
  s = extractSectionBlock(analysisText, "### 3. 人物清单") || extractSectionBlock(analysisText, "### 人物清单");
  return s || "";
}

function extractScenesSection_legacyDuplicate(analysisText) {
  const starts = [
    "### 4. 场景清单",
    "### 场景清单",
    "## 4. 场景清单",
    "## 场景清单",
    "#### 4. 场景清单",
  ];
  const ends = [
    "\n### 5.",
    "\n### 5. 人物与场景关系图",
    "\n## 5.",
    "\n### 6.",
    "\n### 6. 总结",
    "\n## 6.",
  ];
  let s = extractSectionBetween(analysisText, starts, ends);
  if (s) return s;
  s = extractSectionBlock(analysisText, "### 4. 场景清单") || extractSectionBlock(analysisText, "### 场景清单");
  return s || "";
}

async function generateItemsAndStoryline_legacyDuplicate({
  chapterText,
  analysisText,
  projectName,
  visualStyle,
  chapterRangeLabel,
  modelId,
}) {
  const vStyle = (visualStyle || "").trim();
  const pName = (projectName || "").trim() || "未知小说";
  const rangeLabel = (chapterRangeLabel || "第X章").trim();

  const toolPolishFull = safeRead(SKILLS.toolPolish);
  const storyLineFull = safeRead(SKILLS.storyline);

  const toolPolishSnippet = sliceSkillText(toolPolishFull, "## 第三部分：结构描述规范");
  const storyLineSnippet = sliceSkillText(storyLineFull, "## 输出格式");

  // 1) Define Extract visible prop names (items) from chapter text
  const extractItemsSystem = [
    "你是道具/物品提取助手，只从章节原文中抽取“可被镜头拍到”的物品/道具名称。",
    "输出严格 JSON：{ \"items\": [ { \"name\": \"...\" } ] }，不要输出任何解释文字。",
    "规则：",
    "1) 最多 6 个，去重；name 必须是具体名词短语（2-12字），禁止抽象词、情绪词、动作短语。",
    "2) 优先抽取：信物/证据/关键器物/武器/钱袋/玉佩/文书/药瓶等可见物；不要抽取泛化词（如“东西”“物品”“行李”）。",
    "3) 严禁把人物名、地名、时间词当成物品。",
  ].join("\n");

  const extractItemsUser = `小说名：${pName}\n视觉风格：${vStyle}\n章节范围：${rangeLabel}\n\n章节原文：\n${chapterText}\n\n参考分析：\n${analysisText}`;

  const extractItemsPromise = (async () => {
    let itemsText = null;
    try {
      itemsText = await callLlm(
        [
          { role: "system", content: extractItemsSystem },
          { role: "user", content: extractItemsUser },
        ],
        modelId
      );
    } catch (err) {
      console.error("generateItemsAndStoryline: extract items failed:", err?.message || err);
    }
    let names = [];
    if (itemsText) {
      const parsed = parseJsonFromText(itemsText, { items: [] });
      names = Array.isArray(parsed?.items) ? parsed.items.map((x) => String(x.name || "").trim()).filter(Boolean) : [];
    }
    if (!names || names.length === 0) {
      const lines = chapterText.split("\n").map((l) => l.trim()).filter(Boolean);
      const guesses = [];
      for (const l of lines) {
        const m = l.match(/(拿起|拿着|手里|背着|递给|交给|掏出|拔出|握住|打开|举起|取出)?([^，。；,.]{2,20})/);
        if (m && m[2] && !/人|说|看/.test(m[2])) guesses.push(m[2].trim());
        if (guesses.length >= 4) break;
      }
      names = Array.from(new Set(guesses)).slice(0, 4);
    }
    return names;
  })();

  // 3) Define Storyline generation
  const storySystem = [
    "你必须严格遵循 stroy-line-SKLII 的输出格式与规范。",
    "不要输出解释文本，不要输出 Markdown 代码块（不要使用 ```）。",
    "只输出故事线文本本身。",
    storyLineSnippet,
  ].join("\n");

  const storyUser = `小说名：${pName}\n章节范围：${rangeLabel}\n\n章节原文：\n${chapterText}\n\n参考分析（可用于人物/场景提示词，但不要复述分析）：\n${analysisText}`;

  const storylinePromise = (async () => {
    let text = null;
    try {
      text = await callLlm(
        [
          { role: "system", content: storySystem },
          { role: "user", content: storyUser },
        ],
        modelId
      );
    } catch (err) {
      console.error("generateItemsAndStoryline: storyline failed:", err?.message || err);
    }
    return text;
  })();

  // Execute extraction and storyline in parallel
  const [itemNames, storylineText] = await Promise.all([extractItemsPromise, storylinePromise]);

  // 2) Tool-polish each item name into a prompt paragraph (Parallelized)
  const toolPolishSystem = [
    "你必须严格遵循 tool-polish-SKILL 的输出规范。",
    "输出必须只包含“一个连续中文段落”（允许标点），不要出现标题、序号、换行、列表符号。",
    "段落内容只能描述道具本身，不得包含人物、手部、场景、环境、功能说明或情绪词。",
    "长度 80-180 字，强调外观结构+材质+颜色+细节+新旧磨损+尺度感。",
    toolPolishSnippet,
  ].join("\n");

  const itemPromptPairs = await Promise.all(
    itemNames.slice(0, 6).map(async (itemName) => {
      const userPrompt = `输入风格：${vStyle || "写实风"}\n道具名称：${itemName}\n\n请输出道具可视化提示词段落（80-200字）。`;
      let polished = null;
      try {
        polished = await callLlm(
          [
            { role: "system", content: toolPolishSystem },
            { role: "user", content: userPrompt },
          ],
          modelId
        );
      } catch (err) {
        console.error("generateItemsAndStoryline: polish item failed:", err?.message || err);
      }
      let paragraph = (polished || "").trim().replace(/\s*\n\s*/g, " ").slice(0, 600);
      if (!paragraph) {
        paragraph = `${itemName}，清晰的形体比例与材质颜色，表面纹理与细节可见，8k，电影级打光，微距质感。`;
      }
      return { name: itemName, prompt: paragraph };
    })
  );

  const itemsMd =
    itemPromptPairs.length > 0
      ? ["## 物品清单", ...itemPromptPairs.map((p) => `- 物品：${p.name}\n  - 提示词：${p.prompt}`)].join("\n")
      : `## 物品清单\n- 物品：暂无可视化道具\n  - 提示词：暂无`;

  const finalStorylineMd = (storylineText || "").trim()
    ? storylineText.trim()
    : `《${pName}》${rangeLabel} 故事线\n\n【总览】\n时间跨度：单章\n核心主题：围绕冲突推进\n关键转折：本章触发质变\n\n【第一阶段：阶段名称】${rangeLabel}\n- 2-3段概述主要情节（fallback）\n\n【人物关系变化】\n主角：起点 → 新选择\n周边人物：关系变化（fallback）\n\n【重要伏笔】\n1. 伏笔问题（fallback）\n2. 伏笔问题（fallback）\n3. 伏笔问题（fallback）\n\n【节奏与高潮】\n情绪曲线：上升→爆发→余波\n高潮时刻：①本章事件②本章决断\n\n【主题演变】\n第一层：表面冲突 → 具体事件解释\n第二层：行为模式 → 选择决定\n`;

  return { itemsMd, storylineMd: finalStorylineMd };
}

/**
 * 将模型输出的「一行里用 ,.- 镜头2：粘连」或杂乱列表，规整为易读 Markdown。
 * 按「镜头+序号+：」切分；每镜一节 ### 镜头 N，镜间 --- 分隔。
 */
function normalizeStoryboardPromptsMd_legacyDuplicate(md) {
  let s = String(md || "").replace(/\r\n/g, "\n").trim();
  if (!s) return s;

  if (/^##\s*分镜提示词/i.test(s)) {
    s = s.replace(/^##\s*分镜提示词\s*\n*/i, "").trim();
  }
  const title = "## 分镜提示词";

  const re = /镜头\s*(\d+)(?:（[^）]*）)?\s*[：:]/g;
  const hits = [];
  let m;
  while ((m = re.exec(s))) {
    hits.push({ n: m[1], index: m.index, len: m[0].length });
  }

  if (hits.length === 0) {
    return `${title}\n\n${s}`;
  }

  const blocks = [];
  for (let i = 0; i < hits.length; i += 1) {
    const { n, index, len } = hits[i];
    const end = i + 1 < hits.length ? hits[i + 1].index : s.length;
    let body = s.slice(index + len, end).trim();
    body = body.replace(/[,，]\s*-\s*$/g, "").replace(/\n\s*-\s*$/g, "").replace(/[,，.\s\-]+$/g, "").trim();
    body = body.replace(/^[,，\s\-]+/g, "").trim();
    blocks.push(body ? `### 镜头 ${n}\n\n${body}` : `### 镜头 ${n}\n\n（无正文）`);
  }

  let pre = s.slice(0, hits[0].index).trim();
  pre = pre.replace(/^-\s*$/gm, "").replace(/^-\s+/, "").replace(/^[,，.\s\-]+/g, "").trim();
  const preBlock = pre ? `${pre}\n\n` : "";

  return `${title}\n\n${preBlock}${blocks.join("\n\n---\n\n")}`;
}

async function generateStoryboardPrompts_legacyDuplicate({ storyboardMd, storyboardText, analysisText, modelId }) {
  const resolvedStoryboardMd = String(storyboardMd || storyboardText || "").trim();
  const systemPrompt = [
    "你是短剧分镜提示词生成器。",
    "输入包含 storyboardMd（分镜脚本 Markdown 表格）和参考分析文本（人物/场景/物品提示词）。",
    "你的任务不是“重写分镜脚本”，而是：在每一行分镜脚本的基础上，生成一段更连贯、更有动态的画面提示词，让画面能“动起来”。",
    "",
    "你必须逐行读取 storyboardMd 表格，并融合每行的字段信息：",
    "序号、时长、镜头类型、镜头内容、景别、运镜方式、人物动作（或音效/台词字段中的动作信息）。",
    "将这些信息自然组合成一段连贯叙述（画面连续、动作有起承转合），不要只把字段机械拼接。",
    "",
    "硬性内容要求（每个镜头都必须满足）：",
    "1) 提示词正文第一句必须以三段前缀开头并各写具体值：",
    "   【场景】<具体地点·时段> 【人物】<姓名1、姓名2…或无> 【道具/物品】<物品名…或无>",
    "2) 紧接着必须把“景别 + 运镜 + 动作变化”写成动态镜头：",
    "   - 景别：从表格“景别”字段获取并写入（如 全景/中景/近景/特写）。",
    "   - 运镜：从表格“运镜方式”字段获取并写入（如 推进/横移/跟拍/摇镜/拉远）。",
    "   - 动作：以表格“人物动作/镜头内容”的信息为主，写清谁在做什么、动作的起点/过程/结果（例如“抬手—停顿—回头—目光落到某物上”）。",
    "3) 必须补齐可画的画面要素：构图（主体位置/前中后景层次/遮挡）、表情或视线方向、光线与色调（可简短）。",
    "3.1) 【台词必须放在“发生的环节”】若该行表格的「音效/台词」列含对白/台词，或镜头内容中出现明确对话：",
    "   - 你必须把台词插入到对应动作段落中，而不是统一堆在最后一行。",
    "   - 写法：当你描述到“谁开口/谁转头/谁停顿/谁逼近/谁回望”等动作节点时，紧接着在同一行或下一行写：台词（角色名：台词内容）。",
    "   - 多人对话就按时间顺序插入多处：台词（A：...）→动作变化→台词（B：...）。",
    "   - 没有台词则在正文中自然说明“无对白/仅环境声”，不要写专门的末尾汇总行，也不要凭空编台词。",
    "   - 台词出现时必须同步写“说话的动态”：口型、停顿、换气、视线落点、手部小动作或身体重心变化，让观众知道台词发生在什么时候。",
    "4) 禁止抽象套话（如“空间关系建立”“情绪拉满”“氛围感”），必须落到具体动作/构图/光影/物体上。",
    "5) 人物/场景/道具命名优先使用分析文本里的资产名称；不要发明新名字。",
    "",
    "输出格式要求：",
    "- 输出严格 JSON：{ \"promptsMd\": \"...\" }（不要输出解释，不要代码块）。",
    "- promptsMd 排版必须是：第一行 `## 分镜提示词`；每个镜头一节 `### 镜头 N`，空一行，再写该镜头提示词正文。",
    "- 每个镜头提示词正文建议 2-5 行（允许换行以表达动态分层），但不要出现项目符号列表（不要用 - 或 * 开头）。",
    "promptsMd 排版硬性要求（必须遵守，便于人类阅读）：",
    "1）第一行必须是：## 分镜提示词",
    "2）每个镜头单独一节：先写一行「### 镜头 N」（N 为数字），空一行，再写该镜提示词正文；正文可多行，写完再进入下一镜。",
    "3）禁止把所有镜头挤在同一行、用英文逗号或「,.- 镜头2：」这种方式粘连；镜与镜之间用空一行或单独一行「---」分隔。",
    "4）不要使用「- 镜头1：…,- 镜头2：…」这种列表粘连，一律用 ### 标题分段。",
    "5）JSON 里 promptsMd 字符串需含真实换行符（\\n），不要用一行超长字符串。",
    "不要输出解释文本。",
  ].join("\n");

  const userPrompt = `storyboardMd：\n${resolvedStoryboardMd}\n\n参考分析（人物/场景提示词）：\n${analysisText}`;
  const llmText = await callLlm([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], modelId);

  if (!llmText) {
    return "## 分镜提示词\n- 说明：已缺少模型调用，暂未生成逐镜提示词。\n";
  }

  try {
    const parsed = JSON.parse(llmText);
    const raw = parsed.promptsMd || "";
    const normalized = normalizeStoryboardPromptsMd(raw);
    if (String(normalized || "").trim()) return normalized;
  } catch {
    // ignore
  }

  // 容错：模型经常直接吐 Markdown 或在 JSON 外包一层说明；此处兜底为“把全文当 promptsMd”。
  const parsedLoose = parseJsonFromText(llmText, null);
  if (parsedLoose && typeof parsedLoose === "object") {
    const maybe = String(parsedLoose.promptsMd || parsedLoose.prompts_md || "").trim();
    const normalized = normalizeStoryboardPromptsMd(maybe);
    if (normalized) return normalized;
  }

  const fallback = normalizeStoryboardPromptsMd(llmText);
  return (
    String(fallback || "").trim() ||
    "## 分镜提示词\n（说明：模型返回格式异常，未能解析出 promptsMd；请重试生成或在分镜表基础上手动补齐逐镜提示词。）\n"
  );
}

async function auditOutlineAssets_legacyDuplicate({ projectName, outline, modelId }) {
  const directorFull = safeRead(SKILLS.outlineDirector);
  const storyAudit = sliceSkillBetween(
    directorFull,
    "## 🎯 故事线审核标准",
    "## 🎯 大纲审核标准"
  );
  const outputFmt = sliceSkillText(directorFull, "## 📋 审核模板（直接套用）");

  const systemPrompt = [
    "你只审核“故事线是否符合小说逻辑”，不做大纲（JSON）审核。",
    "你必须遵循审核模板的输出要求，不要输出解释文本。",
    storyAudit,
    outputFmt,
  ].join("\n");

  const userPrompt = `小说名：${projectName}\n\n待审核故事线：\n${outline?.storylineMd || ""}\n\n辅助物品清单：\n${outline?.itemsMd || ""}`;

  const llmText = await callLlm([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], modelId);

  if (!llmText) return "✅ 审核通过";
  return llmText.trim();
}

async function getProject(userId, projectId) {

  let proj = await Project.findOne({ id: projectId, userId }).lean();
  if (!proj) {
    // Attempt migration from legacy JSON
    const p = projectSettingsPath(userId, projectId);
    if (fs.existsSync(p)) {
      const settings = readJson(p, null);
      if (settings) {
        proj = await Project.create({ ...settings, id: projectId, userId });
        console.log(`[MongoDB] Migrated project settings for ${projectId}`);
      }
    }
  }
  return proj;
}

async function saveProject(userId, projectId, data) {
  await Project.findOneAndUpdate(
    { id: projectId, userId },
    { ...data, id: projectId, userId },
    { upsert: true, new: true }
  );
}

async function getChapters(userId, projectId) {
  let chapters = await Chapter.find({ projectId, userId }).sort({ order: 1 }).lean();
  if (chapters.length === 0) {
    const p = novelChaptersPath(userId, projectId);
    if (fs.existsSync(p)) {
      const data = readJson(p, { chapters: [] });
      if (data.chapters && data.chapters.length > 0) {
        for (let i = 0; i < data.chapters.length; i++) {
          const c = data.chapters[i];
          await Chapter.create({ ...c, projectId, userId, order: i });
        }
        console.log(`[MongoDB] Migrated ${data.chapters.length} chapters for ${projectId}`);
        chapters = await Chapter.find({ projectId, userId }).sort({ order: 1 }).lean();
      }
    }
  }
  return chapters;
}

function normalizeTitle(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function chapterNumericId(chapterId) {
  const m = String(chapterId || "").match(/^c_(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function isDuplicateKeyError(err) {
  return Number(err?.code) === 11000 || /duplicate key/i.test(String(err?.message || ""));
}

async function replaceAllChapters(userId, projectId, chapters) {
  await Chapter.deleteMany({ projectId, userId });
  for (let i = 0; i < chapters.length; i++) {
    await Chapter.create({ ...chapters[i], projectId, userId, order: i });
  }
}

// Keep old name for any remaining call-sites
const saveChapters = replaceAllChapters;

async function appendChapters(userId, projectId, newChapters) {
  let retries = 0;
  while (retries < 3) {
    try {
      const existing = await Chapter.find({ projectId, userId }).sort({ order: 1 }).lean();
      let maxOrder = existing.reduce((m, c) => Math.max(m, c.order ?? -1), -1);
      let nextNumericId = existing.reduce((m, c) => Math.max(m, chapterNumericId(c.id)), 0);
      const titleSet = new Set(existing.map((c) => normalizeTitle(c.title)));

      const toInsert = [];
      let autoTitledCount = 0;
      for (const c of newChapters) {
        if (c._autoTitle) {
          // No chapter markers in the text: always append, assign sequential title
          maxOrder += 1;
          nextNumericId += 1;
          const seqTitle = `第${nextNumericId}章`;
          toInsert.push({ ...c, projectId, userId, order: maxOrder, id: `c_${nextNumericId}`, title: seqTitle, _autoTitle: undefined });
          titleSet.add(normalizeTitle(seqTitle));
          autoTitledCount += 1;
        } else {
          // Has real chapter marker: title-based dedup
          const key = normalizeTitle(c.title);
          if (titleSet.has(key)) continue;
          titleSet.add(key);
          maxOrder += 1;
          nextNumericId += 1;
          toInsert.push({ ...c, projectId, userId, order: maxOrder, id: `c_${nextNumericId}` });
        }
      }

      if (toInsert.length > 0) {
        await Chapter.insertMany(toInsert);
      }

      const allChapters = await Chapter.find({ projectId, userId }).sort({ order: 1 }).lean();
      return { added: toInsert.length, skipped: newChapters.length - toInsert.length, autoTitledCount, chapters: allChapters };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      retries += 1;
      if (retries >= 3) throw err;
    }
  }
}

async function getOutline(userId, projectId, chapterId) {
  let outline = await Outline.findOne({ projectId, chapterId, userId }).lean();
  if (!outline) {
    const p = outlinePath(userId, projectId, chapterId);
    if (fs.existsSync(p)) {
      const data = readJson(p, null);
      if (data) {
        outline = await Outline.create({ ...data, projectId, userId, chapterId });
        console.log(`[MongoDB] Migrated outline for ${projectId}/${chapterId}`);
      }
    }
  }
  return outline;
}

async function saveOutline(userId, projectId, chapterId, data) {
  // Avoid MongoDB immutable field update errors when callers spread lean() docs
  // (lean docs typically contain _id/__v, which must not be written back).
  const payload = { ...(data || {}) };
  delete payload._id;
  delete payload.__v;
  await Outline.findOneAndUpdate(
    { projectId, chapterId, userId },
    { ...payload, projectId, userId, chapterId },
    { upsert: true, returnDocument: "after" }
  );
}

async function getAssets(userId, projectId, chapterId) {
  let assets = await Asset.findOne({ projectId, chapterId, userId }).lean();
  if (!assets) {
    const p = assetsPath(userId, projectId, chapterId);
    if (fs.existsSync(p)) {
      const data = readJson(p, null);
      if (data) {
        assets = await Asset.create({ ...data, projectId, userId, chapterId });
        console.log(`[MongoDB] Migrated assets for ${projectId}/${chapterId}`);
      }
    }
  }
  return assets;
}

async function saveAssets(userId, projectId, chapterId, data) {
  // Avoid MongoDB immutable field update errors when callers spread lean() docs
  const payload = { ...(data || {}) };
  delete payload._id;
  delete payload.__v;
  await Asset.findOneAndUpdate(
    { projectId, chapterId, userId },
    { ...payload, projectId, userId, chapterId },
    { upsert: true, returnDocument: "after" }
  );
}

const BCRYPT_COST = 12;

function isBcryptPasswordHash(stored) {
  return typeof stored === "string" && /^\$2[aby]\$\d{2}\$/.test(stored);
}

async function hashUserPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_COST);
}

/** 中国大陆手机号：11 位，1 开头，第二位 3–9 */
function isValidCnMobile(phone) {
  const s = String(phone || "").trim();
  return /^1[3-9]\d{9}$/.test(s);
}

// -----------------------------
// SMS verification (ihuyi.com)
// -----------------------------
// In-memory store: sufficient for single-node dev; restart will clear pending codes.
const smsCodeStore = new Map(); // phone -> { code, purpose, expiresAt, lastSentAt, sentCountDay, dayKey }

function dayKeyNow() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

function genSmsCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function upsertSmsCode(phone, purpose) {
  const now = Date.now();
  const dk = dayKeyNow();
  const prev = smsCodeStore.get(phone);
  const lastSentAt = prev?.lastSentAt || 0;
  const prevDayKey = prev?.dayKey || dk;
  const sentCountDay = prevDayKey === dk ? Number(prev?.sentCountDay || 0) : 0;

  // rate limit: 60s cooldown, 10/day per phone (align with typical limits)
  if (now - lastSentAt < 60_000) {
    const err = new Error("发送过于频繁，请稍后再试");
    err.statusCode = 429;
    throw err;
  }
  if (sentCountDay >= 10) {
    const err = new Error("该手机号今日验证码发送次数已达上限");
    err.statusCode = 429;
    throw err;
  }

  const code = genSmsCode();
  const expiresAt = now + 5 * 60_000; // 5 min
  smsCodeStore.set(phone, {
    code,
    purpose,
    expiresAt,
    lastSentAt: now,
    sentCountDay: sentCountDay + 1,
    dayKey: dk,
  });
  return code;
}

function verifySmsCode(phone, purpose, code) {
  const row = smsCodeStore.get(phone);
  const now = Date.now();
  if (!row) return { ok: false, reason: "no_code" };
  if (row.purpose !== purpose) return { ok: false, reason: "purpose_mismatch" };
  if (now > Number(row.expiresAt || 0)) return { ok: false, reason: "expired" };
  if (String(row.code || "") !== String(code || "")) return { ok: false, reason: "code_mismatch" };
  // one-time use
  smsCodeStore.delete(phone);
  return { ok: true };
}

function smsVerifyReasonToMessage(reason) {
  switch (reason) {
    case "no_code":
      return "请先获取验证码";
    case "expired":
      return "验证码已过期，请重新获取";
    case "code_mismatch":
      return "验证码错误，请重试";
    case "purpose_mismatch":
      return "验证码用途不匹配，请重新获取";
    default:
      return "验证码无效，请重新获取";
  }
}

async function sendIhuyiSms({ mobile, content, templateid }) {
  const account = String(process.env.IHUYI_ACCOUNT || "").trim();
  const apiKey = String(process.env.IHUYI_APIKEY || "").trim();
  if (!account || !apiKey) {
    const err = new Error("短信服务未配置（缺少 IHUYI_ACCOUNT/IHUYI_APIKEY）");
    err.statusCode = 503;
    throw err;
  }
  const url = "https://api.ihuyi.com/sms/Submit.json";
  const body = new URLSearchParams();
  body.set("account", account);
  body.set("password", apiKey);
  body.set("mobile", mobile);
  if (templateid) body.set("templateid", String(templateid));
  if (content != null) body.set("content", String(content));

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const err = new Error(`短信发送失败: HTTP ${resp.status} ${text}`);
    err.statusCode = 502;
    throw err;
  }
  const code = Number(data?.code);
  if (code !== 2) {
    const msg = String(data?.msg || "提交失败");
    const err = new Error(`短信发送失败: ${code || "?"} ${msg}`);
    err.statusCode = 502;
    err.vendorCode = code;
    throw err;
  }
  return { ok: true, smsid: String(data?.smsid || "") };
}

async function verifyUserPassword(plain, stored) {
  const st = String(stored || "");
  if (isBcryptPasswordHash(st)) {
    return bcrypt.compare(String(plain), st);
  }
  const p = String(plain);
  if (p.length !== st.length) return false;
  const a = Buffer.from(p, "utf8");
  const b = Buffer.from(st, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function requireAuth(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: "not logged in" });
  const user = await findUserById(userId);
  if (!user) return res.status(401).json({ error: "user not found" });
  if (user.accountDisabled) return res.status(403).json({ error: "account disabled" });
  req.userId = userId;
  req.user = user;
  next();
}

function withRequestContext(req, _res, next) {
  requestContext.run({ userId: req.userId || null }, () => next());
}

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = req.user;
  const fresh = (await findUserById(user.id)) || user;
  if (ensureUserBillingFields(fresh)) await saveUser(fresh);
  const resolvedText = resolveUserTextConfig(fresh);
  const selectedTextModelId = resolvedText.isCustom ? "custom:oioiapi" : resolveUserModel(fresh);
  res.json({
    user: {
      id: fresh.id,
      phone: fresh.phone,
      selectedModelId: selectedTextModelId,
      selectedImageModelId: resolveUserImageModelId(fresh),
      selectedImageAspectRatio: resolveUserImageAspectRatio(fresh),
      pointsBalance: Number(fresh.pointsBalance || 0),
      tokenUsage: fresh.tokenUsage || { prompt: 0, completion: 0, total: 0 },
      pointsSpent: Number(fresh.pointsSpent || 0),
      isAdmin: userIsAdmin(fresh),
    },
  });
});

function billingDefaults() {
  const initPoints = Number(process.env.INITIAL_USER_POINTS || 100);
  const safeInit = Number.isFinite(initPoints) ? Math.max(0, Math.floor(initPoints)) : 100;
  return {
    pointsBalance: safeInit,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    pointsSpent: 0,
    billingLogs: [],
    billingUpdatedAt: new Date().toISOString(),
  };
}

function ensureUserBillingFields(user) {
  if (!user || typeof user !== "object") return false;
  let changed = false;
  const defs = billingDefaults();
  if (!Number.isFinite(Number(user.pointsBalance))) {
    user.pointsBalance = defs.pointsBalance;
    changed = true;
  }
  if (!user.tokenUsage || typeof user.tokenUsage !== "object") {
    user.tokenUsage = { ...defs.tokenUsage };
    changed = true;
  } else {
    if (!Number.isFinite(Number(user.tokenUsage.prompt))) {
      user.tokenUsage.prompt = 0;
      changed = true;
    }
    if (!Number.isFinite(Number(user.tokenUsage.completion))) {
      user.tokenUsage.completion = 0;
      changed = true;
    }
    if (!Number.isFinite(Number(user.tokenUsage.total))) {
      user.tokenUsage.total = 0;
      changed = true;
    }
  }
  if (!Number.isFinite(Number(user.pointsSpent))) {
    user.pointsSpent = 0;
    changed = true;
  }
  if (!Array.isArray(user.billingLogs)) {
    user.billingLogs = [];
    changed = true;
  }
  if (!user.billingUpdatedAt) {
    user.billingUpdatedAt = new Date().toISOString();
    changed = true;
  }
  if (
    user.selectedModelId === "gpt-5.2" ||
    user.selectedModelId === "gpt-5.4" ||
    user.selectedModelId === "gemini-3.1-pro-preview" ||
    user.selectedModelId === "gemini-3-pro-preview"
  ) {
    user.selectedModelId = "gpt-5.1";
    changed = true;
  }
  return changed;
}

function getLowBalanceThreshold() {
  const v = Number(process.env.LOW_BALANCE_THRESHOLD || 5000);
  if (!Number.isFinite(v) || v < 0) return 5000;
  return Math.floor(v);
}

function appendBillingLog(user, logItem) {
  if (!user || !logItem) return;
  user.billingLogs = Array.isArray(user.billingLogs) ? user.billingLogs : [];
  user.billingLogs.unshift(logItem);
  if (user.billingLogs.length > 1000) user.billingLogs.length = 1000;
}

function sanitizeUserForAdminList(user) {
  if (!user) return null;
  return {
    id: user.id,
    phone: user.phone,
    pointsBalance: Number(user.pointsBalance || 0),
    pointsSpent: Number(user.pointsSpent || 0),
    createdAt: user.createdAt || null,
    billingUpdatedAt: user.billingUpdatedAt || null,
    accountDisabled: Boolean(user.accountDisabled),
    selectedModelId: user.selectedModelId || null,
    selectedImageModelId: user.selectedImageModelId || null,
    selectedImageAspectRatio: user.selectedImageAspectRatio || null,
    passwordUpdatedAt: user.passwordUpdatedAt || null,
  };
}

function applyAdminPointsAdjustment(user, delta, { adminUserId, adminPhone, reason }) {
  ensureUserBillingFields(user);
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || d === 0) {
    const err = new Error("delta 须为非零整数");
    err.statusCode = 400;
    throw err;
  }
  const cur = Number(user.pointsBalance || 0);
  if (d < 0 && cur + d < 0) {
    const err = new Error("积分不足，无法扣减至负值");
    err.statusCode = 400;
    throw err;
  }
  user.pointsBalance = cur + d;
  user.billingUpdatedAt = new Date().toISOString();
  appendBillingLog(user, {
    type: "admin_adjust",
    delta: d,
    pointsBalanceAfter: Number(user.pointsBalance),
    reason: String(reason || "").trim(),
    adminUserId: adminUserId || "",
    adminPhone: String(adminPhone || "").trim(),
    at: user.billingUpdatedAt,
  });
}

function normalizeAdminPhone(s) {
  let x = String(s ?? "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/\u200B/g, "")
    .replace(/\s+/g, "");
  if (x.startsWith("+86")) x = x.slice(3);
  else if (x.startsWith("0086")) x = x.slice(4);
  else if (/^86\d{11}$/.test(x)) x = x.slice(2);
  return x;
}

function parseAdminPhones() {
  const raw = String(process.env.ADMIN_PHONES || "");
  return raw
    .split(/[,;\s\n\r]+/)
    .map((s) => normalizeAdminPhone(s))
    .filter(Boolean);
}

function requireAdmin(req, res, next) {
  const phones = parseAdminPhones();
  if (!phones.length) return res.status(503).json({ error: "admin phones not configured" });
  const phone = normalizeAdminPhone(req.user?.phone);
  if (!phones.includes(phone)) return res.status(403).json({ error: "forbidden" });
  next();
}

function userIsAdmin(user) {
  const phones = parseAdminPhones();
  if (!phones.length) return false;
  return phones.includes(normalizeAdminPhone(user?.phone));
}

function getPointsPerToken() {
  const v = Number(process.env.POINTS_PER_TOKEN || 1);
  if (!Number.isFinite(v) || v < 0) return 1;
  return v;
}

function roundToHalf(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 2) / 2;
}

function pointsPer1kFromUsdPer1m(usdPer1m) {
  const v = Number(usdPer1m);
  if (!Number.isFinite(v) || v < 0) return 0;
  // 用户计费价（$/1M）→ 积分/1K：汇率 × 利润倍率 ÷ (YUAN_PER_POINT×1000)；YUAN_PER_POINT 见环境变量，默认与「nano 约 6 次/千分」对齐
  const usdToCny = Number(process.env.USD_TO_CNY || 7.2);
  const profitMultiplier = Number(process.env.PROFIT_MULTIPLIER || 2);
  // 积分「扣费锚点」：与充值标价（如 9.9 元/1000 积分）可分离；默认按 nano 多步拆解约 6 万 token/次量级，
  // 使 1000 积分约可支撑 6 次全流程（见 .env.example 说明）。调低则单次扣费变多，调高则变少。
  const yuanPerPoint = Number(process.env.YUAN_PER_POINT || 0.0275);
  if (!Number.isFinite(usdToCny) || usdToCny <= 0) return 0;
  if (!Number.isFinite(profitMultiplier) || profitMultiplier <= 0) return 0;
  if (!Number.isFinite(yuanPerPoint) || yuanPerPoint <= 0) return 0;

  const pointsPer1kExact = (v * usdToCny * profitMultiplier) / (yuanPerPoint * 1000);
  // 按 0.5 档位取整（例如 2.545→2.5，20.364→20.5）
  return Math.max(0, roundToHalf(pointsPer1kExact));
}

function modelPricingUsdPer1m(modelId) {
  const id = String(modelId || "").trim();
  const table = {
    // 这里是“对用户计费价”（sell price），不是你的成本价。
    // 基准：nano = 1/8（$/1M）。同 prompt/completion 下积分比 = (a·P+b·C)/(P+8C)；令 a=k、b=8k 即得对 nano 的 k 倍。
    "gpt-5-nano": { prompt: 1.0, completion: 8.0 },
    "gpt-5.4-mini": { prompt: 1.0, completion: 8.0 },
    "gpt-5.1": { prompt: 3.0, completion: 24.0 },
    "gpt-5.1-chat": { prompt: 3.0, completion: 24.0 },
    "gemini-3-pro-preview": { prompt: 7.0, completion: 56.0 },
    "gemini-3.1-pro-preview": { prompt: 7.0, completion: 56.0 },
    "gpt-5.4": { prompt: 7.0, completion: 56.0 },
    "qwen3-max": { prompt: 7.0, completion: 56.0 },
    "deepseek-v3.2": { prompt: 2.0, completion: 16.0 },
    "deepseek-v3.2-thinking": { prompt: 5.0, completion: 40.0 },
    // 未配置的模型先按 gpt-5.1（3×nano）兜底（避免扣费为 0）
  };
  Object.assign(table, CUSTOM_TEXT_PRICING);
  return table[id] || table["gpt-5.1"];
}

function calcPointsCostByModelTokens({ modelId, promptTokens, completionTokens, totalTokens }) {
  const pricing = modelPricingUsdPer1m(modelId);
  const pPer1k = pointsPer1kFromUsdPer1m(pricing.prompt);
  const cPer1k = pointsPer1kFromUsdPer1m(pricing.completion);
  const pCost = (Number(promptTokens || 0) / 1000) * pPer1k;
  const cCost = (Number(completionTokens || 0) / 1000) * cPer1k;

  const computed = Math.ceil(Math.max(0, pCost + cCost));
  // 若上游未提供 prompt/completion 拆分（极少数情况），回退到旧规则保证扣费非 0
  if (!computed && Number(totalTokens || 0) > 0) {
    const pointsPerToken = getPointsPerToken();
    return Math.max(0, Math.ceil(Number(totalTokens || 0) * pointsPerToken));
  }
  return computed;
}

async function assertUserHasPoints(userId) {
  if (!userId) return;
  const user = await findUserById(userId);
  if (!user) return;
  const changed = ensureUserBillingFields(user);
  if (changed) await saveUser(user);
  if (Number(user.pointsBalance) <= 0) {
    throw new Error("积分不足，请先充值后重试");
  }
}

async function assertUserHasImagePoints(userId, requiredPoints) {
  const need = Math.max(0, Math.floor(Number(requiredPoints || 0)));
  if (!need) return;
  const user = await findUserById(userId);
  if (!user) return;
  const changed = ensureUserBillingFields(user);
  if (changed) await saveUser(user);
  if (Number(user.pointsBalance || 0) < need) {
    throw new Error(`积分不足：当前需至少 ${need} 积分`);
  }
}

app.post("/api/projects/:projectId/rename", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });

    const proj = await Project.findOneAndUpdate(
      { id: projectId, userId: req.userId },
      { name: safeSlugName(name), updatedAt: new Date().toISOString() },
      { new: true }
    );
    if (!proj) return res.status(404).json({ error: "project not found" });

    res.json({ ok: true, name: proj.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function recordUserUsageAndDeductPoints(userId, usage, modelId) {
  if (!userId || !usage || typeof usage !== "object") return;
  const promptTokens = Math.max(0, Number(usage.prompt_tokens || usage.promptTokens || 0));
  const completionTokens = Math.max(0, Number(usage.completion_tokens || usage.completionTokens || 0));
  const totalTokensRaw = Number(usage.total_tokens || usage.totalTokens || 0);
  const totalTokens = Math.max(0, totalTokensRaw || promptTokens + completionTokens);
  if (!totalTokens) return;

  const user = await findUserById(userId);
  if (!user) return;
  ensureUserBillingFields(user);

  user.tokenUsage.prompt += promptTokens;
  user.tokenUsage.completion += completionTokens;
  user.tokenUsage.total += totalTokens;

  const cost = calcPointsCostByModelTokens({ modelId, promptTokens, completionTokens, totalTokens });
  user.pointsSpent += cost;
  user.pointsBalance = Math.max(0, Number(user.pointsBalance) - cost);
  user.billingUpdatedAt = new Date().toISOString();
  user.lastUsage = {
    modelId: modelId || "",
    promptTokens,
    completionTokens,
    totalTokens,
    pointsCost: cost,
    at: user.billingUpdatedAt,
  };
  appendBillingLog(user, {
    type: "usage",
    modelId: modelId || "",
    promptTokens,
    completionTokens,
    totalTokens,
    pointsCost: cost,
    at: user.billingUpdatedAt,
  });

  await saveUser(user);
}

async function recordUserImageUsageAndDeductPoints({ userId, imageModelId, pointsCost, aspectRatio, projectId, chapterId, taskId }) {
  const cost = Math.max(0, Math.floor(Number(pointsCost || 0)));
  if (!cost) return;
  const user = await findUserById(userId);
  if (!user) return;
  ensureUserBillingFields(user);
  if (Number(user.pointsBalance || 0) < cost) {
    throw new Error(`积分不足：当前需至少 ${cost} 积分`);
  }

  user.pointsSpent = Number(user.pointsSpent || 0) + cost;
  user.pointsBalance = Number(user.pointsBalance || 0) - cost;
  user.billingUpdatedAt = new Date().toISOString();
  user.lastUsage = {
    type: "image_usage",
    imageModelId: imageModelId || "",
    pointsCost: cost,
    aspectRatio: aspectRatio || "",
    projectId: projectId || "",
    chapterId: chapterId || "",
    taskId: taskId || "",
    at: user.billingUpdatedAt,
  };
  appendBillingLog(user, {
    type: "image_usage",
    imageModelId: imageModelId || "",
    pointsCost: cost,
    aspectRatio: aspectRatio || "",
    projectId: projectId || "",
    chapterId: chapterId || "",
    taskId: taskId || "",
    at: user.billingUpdatedAt,
  });
  await saveUser(user);
}

function resolveUserModel(user) {
  let selected = user?.selectedModelId;
  if (
    selected === "gpt-5.2" ||
    selected === "gpt-5.4" ||
    selected === "gemini-3.1-pro-preview" ||
    selected === "gemini-3-pro-preview"
  ) {
    selected = "gpt-5.1";
  }
  if (selected && MODEL_OPTIONS.some((m) => m.modelId === selected)) return selected;
  return process.env.OPENAI_MODEL || "gpt-5.1";
}

function resolveUserTextConfig(user) {
  const c = user?.customTextModel;
  const customApiKey = resolveCustomTextApiKey(c);
  if (
    user?.selectedModelId === "custom:oioiapi" &&
    c?.enabled &&
    customApiKey &&
    String(c.modelName || "").trim()
  ) {
    return {
      isCustom:    true,
      apiKey:      customApiKey,
      baseUrl:     effectiveOioiapiBaseUrl(),
      modelId:     String(c.modelName).trim(),
      skipBilling: true,
    };
  }
  return {
    isCustom:    false,
    apiKey:      process.env.OPENAI_API_KEY,
    baseUrl:     String(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/g, ""),
    modelId:     resolveUserModel(user),
    skipBilling: false,
  };
}

function resolveUserImageModelId(user) {
  const selected = String(user?.selectedImageModelId || "").trim();
  if (selected && IMAGE_MODEL_OPTIONS.some((m) => m.modelId === selected)) return selected;
  return IMAGE_MODEL_OPTIONS[0]?.modelId || "nano-banana2";
}

function resolveUserImageAspectRatio(user) {
  const selected = String(user?.selectedImageAspectRatio || "").trim();
  if (IMAGE_ASPECT_RATIO_OPTIONS.includes(selected)) return selected;
  const envDefault = String(process.env.TOAPIS_IMAGE_SIZE || "16:9").trim();
  if (IMAGE_ASPECT_RATIO_OPTIONS.includes(envDefault)) return envDefault;
  return "16:9";
}

function resolveToapisModelByImageModelId(imageModelId) {
  const hit = IMAGE_MODEL_OPTIONS.find((x) => x.modelId === imageModelId);
  return String(hit?.toapisModel || process.env.TOAPIS_IMAGE_MODEL || "gemini-3.1-flash-image-preview").trim();
}

function resolveImageModelNameById(imageModelId) {
  const hit = IMAGE_MODEL_OPTIONS.find((x) => x.modelId === imageModelId);
  return String(hit?.modelName || imageModelId || "Nano banana2（最强画质·推荐）");
}

function resolveImageModelPointsCost(imageModelId) {
  const hit = IMAGE_MODEL_OPTIONS.find((x) => x.modelId === imageModelId);
  const v = Number(hit?.pointsCost || 0);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

app.post("/api/auth/register", async (req, res) => {
  try {
    ensureUsersIndex();
    const { phone, password, verifyCode } = req.body || {};
    const normalized = String(phone || "").trim();
    if (!normalized) return res.status(400).json({ error: "phone required" });
    if (!isValidCnMobile(normalized)) {
      return res.status(400).json({ error: "手机号须为11位中国大陆号码（1开头，第二位3-9）" });
    }
    if (!password || String(password).length < 6) return res.status(400).json({ error: "password too short" });

    // 如果已注册，直接提示（不要用“重复注册覆盖密码”的行为）
    const existing = await findUserByPhone(normalized);
    if (existing) return res.status(409).json({ error: "该手机号已注册，请直接登录或使用“忘记密码”重置" });

    const code = String(verifyCode || "").trim();
    if (!code) return res.status(400).json({ error: "verifyCode required" });
    const v = verifySmsCode(normalized, "register", code);
    if (!v.ok) return res.status(400).json({ error: smsVerifyReasonToMessage(v.reason) });

    const defs = billingDefaults();
    const passwordHash = await hashUserPassword(password);
    const user = {
      id: `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      phone: normalized,
      password: passwordHash,
      selectedModelId: process.env.OPENAI_MODEL || "gpt-5.1",
      selectedImageModelId: IMAGE_MODEL_OPTIONS[0]?.modelId || "nano-banana2",
      selectedImageAspectRatio: resolveUserImageAspectRatio({}),
      pointsBalance: defs.pointsBalance,
      tokenUsage: { ...defs.tokenUsage },
      pointsSpent: defs.pointsSpent,
      billingUpdatedAt: defs.billingUpdatedAt,
      createdAt: new Date().toISOString(),
      accountDisabled: false,
    };
    await saveUser(user);

    req.session.userId = user.id;
    await saveSession(req);

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        selectedModelId: user.selectedModelId,
        selectedImageModelId: user.selectedImageModelId,
        selectedImageAspectRatio: user.selectedImageAspectRatio,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    ensureUsersIndex();
    const { phone, password } = req.body || {};
    const normalized = String(phone || "").trim();
    if (!normalized) return res.status(400).json({ error: "phone required" });
    if (!isValidCnMobile(normalized)) {
      return res.status(400).json({ error: "手机号格式不正确" });
    }
    if (!password) return res.status(400).json({ error: "password required" });

    const user = await findUserByPhone(normalized);
    if (!user) return res.status(404).json({ error: "user not found, please register first" });
    if (user.accountDisabled) return res.status(403).json({ error: "account disabled" });
    const ok = await verifyUserPassword(password, user.password);
    if (!ok) return res.status(401).json({ error: "password incorrect" });
    if (!isBcryptPasswordHash(user.password)) {
      user.password = await hashUserPassword(password);
      user.passwordUpdatedAt = new Date().toISOString();
    }
    if (!user.selectedModelId) {
      user.selectedModelId = process.env.OPENAI_MODEL || "gpt-5.1";
    }
    if (!user.selectedImageModelId) {
      user.selectedImageModelId = IMAGE_MODEL_OPTIONS[0]?.modelId || "nano-banana2";
    }
    if (!user.selectedImageAspectRatio || !IMAGE_ASPECT_RATIO_OPTIONS.includes(String(user.selectedImageAspectRatio))) {
      user.selectedImageAspectRatio = resolveUserImageAspectRatio(user);
    }
    ensureUserBillingFields(user);
    await saveUser(user);

    req.session.userId = user.id;
    await saveSession(req);

    res.json({
      user: {
        id: user.id,
        phone: user.phone,
        selectedModelId: user.selectedModelId,
        selectedImageModelId: user.selectedImageModelId,
        selectedImageAspectRatio: user.selectedImageAspectRatio,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/verify-sms", async (req, res) => {
  try {
    const { phone, purpose } = req.body || {};
    const normalized = String(phone || "").trim();
    const p = String(purpose || "register").trim() || "register";
    if (!normalized) return res.status(400).json({ error: "phone required" });
    if (!isValidCnMobile(normalized)) return res.status(400).json({ error: "手机号格式不正确" });
    if (p !== "register" && p !== "reset") return res.status(400).json({ error: "purpose must be register/reset" });

    const code = upsertSmsCode(normalized, p);
    // 使用系统默认模板：templateid=1，content=变量
    await sendIhuyiSms({
      mobile: normalized,
      templateid: 1,
      content: code,
    });
    res.json({ ok: true });
  } catch (err) {
    const code = err.statusCode || 500;
    res.status(code).json({ error: err.message || "failed" });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    ensureUsersIndex();
    const { phone, newPassword, verifyCode } = req.body || {};
    const normalized = String(phone || "").trim();
    const pwd = String(newPassword || "");
    const code = String(verifyCode || "").trim();
    if (!normalized) return res.status(400).json({ error: "phone required" });
    if (!isValidCnMobile(normalized)) {
      return res.status(400).json({ error: "手机号格式不正确" });
    }
    if (!pwd || pwd.length < 6) return res.status(400).json({ error: "newPassword 至少6位" });
    if (!code) return res.status(400).json({ error: "verifyCode required" });

    const user = await findUserByPhone(normalized);
    if (!user) return res.status(404).json({ error: "user not found" });

    const v = verifySmsCode(normalized, "reset", code);
    if (!v.ok) return res.status(400).json({ error: smsVerifyReasonToMessage(v.reason) });

    user.password = await hashUserPassword(pwd);
    user.passwordUpdatedAt = new Date().toISOString();
    ensureUserBillingFields(user);
    await saveUser(user);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  try {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  } catch {
    res.json({ ok: true });
  }
});

// -----------------------------
// Alipay payment routes
// -----------------------------
app.get("/pay/alipay", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "pay_alipay.html"));
});

app.post("/api/pay/alipay/page", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const plan = resolveRechargePlan(body.planId);
    if (!plan && !allowCustomPay()) {
      return res.status(400).json({ error: "请传 planId（服务端定价）。如需自定义金额用于调试，请设置 ALLOW_CUSTOM_PAY=1" });
    }

    const subject = String(plan?.title || body.subject || "Xflow 充值").trim().slice(0, 256) || "Xflow 充值";
    const amount = plan ? Number(plan.priceYuan) : Number(body.amount || 0);
    const points = plan ? Math.floor(Number(plan.points)) : Math.floor(Number(body.points || 0));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "amount must be > 0" });
    if (!Number.isFinite(points) || points <= 0) return res.status(400).json({ error: "points must be > 0" });
    if (!plan) {
      const maxRatio = Math.max(...RECHARGE_PLANS.map(p => p.points / p.priceYuan));
      if (points / amount > maxRatio * 1.01) {
        return res.status(400).json({ error: "自定义支付的积分/金额比率超出允许范围" });
      }
      if (amount < 0.01 || amount > 10000) {
        return res.status(400).json({ error: "金额必须在 0.01 ~ 10000 之间" });
      }
    }
    const totalAmount = amount.toFixed(2);

    const base = getPublicBaseUrl(req);
    const notifyUrl = String(process.env.ALIPAY_NOTIFY_URL || `${base}/api/pay/alipay/notify`).trim();
    const returnUrl = String(process.env.ALIPAY_RETURN_URL || `${base}/pay/alipay/return`).trim();

    const outTradeNo = newOutTradeNo("pc");
    const user = await findUserById(req.userId);
    await Order.findOneAndUpdate(
      { outTradeNo },
      {
        outTradeNo,
        subject,
        totalAmount,
        points,
        channel: "page",
        status: "CREATED",
        userId: req.userId,
        userPhone: user?.phone ? String(user.phone) : "",
        planId: plan?.id || "",
        createdAt: new Date().toISOString(),
      },
      { upsert: true }
    );

    const pid = process.env.ZPAY_PID || "";
    const key = process.env.ZPAY_KEY || "";
    const apiUrl = process.env.ZPAY_API_URL || "https://z-pay.cn/submit.php";
    const sitename = process.env.ZPAY_SITENAME || "Xflow";
    const type = body.type || "alipay"; // 默认支付宝

    const params = {
      pid,
      money: totalAmount,
      name: subject,
      notify_url: notifyUrl,
      out_trade_no: outTradeNo,
      return_url: returnUrl,
      sitename,
      type,
    };

    const sign = signZpay(params, key);
    const finalParams = {
      ...params,
      sign,
      sign_type: "MD5",
    };
    const redirectUrl = `${apiUrl}?${querystring.stringify(finalParams)}`;

    res.json({ ok: true, url: redirectUrl });
  } catch (err) {
    res.status(500).json({ error: err.message || "failed" });
  }
});

app.post("/api/pay/alipay/wap", requireAuth, async (req, res) => {
  // 聚合支付中 WAP 和 PC 通常使用相同的 submit.php 逻辑，只是前端展示不同。
  // 我们直接复用 page 的逻辑，或根据需要进行微调。
  return await app._router.handle({ method: "POST", url: "/api/pay/alipay/page", body: req.body, userId: req.userId }, res, () => {});
});



app.get("/pay/alipay/return", async (req, res) => {
  try {
    const params = req.query || {};
    const key = process.env.ZPAY_KEY || "";
    const pid = process.env.ZPAY_PID || "";

    const okSign = verifyZpaySign(params, key);
    const outTradeNo = String(params.out_trade_no || "").trim();
    const tradeStatus = String(params.trade_status || "").trim();

    let status = "验证失败";
    let extraHint = "";

    if (okSign && String(params.pid) === pid && tradeStatus === "TRADE_SUCCESS") {
      status = "支付成功";
      // 主动同步一次状态（解决局域网/localhost 无法接收异步通知的问题）
      if (outTradeNo) {
        const queryRes = await queryZpayOrder(outTradeNo);
        if (queryRes.ok && queryRes.status === "PAID") {
          extraHint = "积分已到账。";
        } else {
          extraHint = "正在同步积分到账状态，请稍后刷新。";
        }
      }
    } else if (okSign && tradeStatus !== "TRADE_SUCCESS") {
      status = "等待支付完成";
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>支付结果</title>
<link rel="stylesheet" href="/style.css"/></head>
<body style="padding:24px;">
  <h3>支付同步返回</h3>
  <p>订单号：<code>${escapeHtml(outTradeNo || "-")}</code></p>
  <p>当前状态：<b>${escapeHtml(status)}</b></p>
  <p style="color:#00ff00;">${escapeHtml(extraHint)}</p>
  <p style="color:rgba(235,244,255,0.8);">提示：最终支付结果以异步通知（notify）为准，如未更新可稍后刷新或在后台查询。</p>
  <p><a href="/workspace.html">返回工作台</a></p>
</body></html>`);
  } catch (err) {
    res.status(500).send("Internal Error");
  }
});

// 支持 GET 和 POST，Z-Pay 异步通知默认使用 GET
const zpayNotifyHandler = async (req, res) => {
  try {
    const params = { ...(req.query || {}), ...(req.body || {}) };
    const pid = process.env.ZPAY_PID || "";
    const key = process.env.ZPAY_KEY || "";

    const okSign = verifyZpaySign(params, key);
    if (!okSign) return res.status(400).send("fail");

    const outTradeNo = String(params.out_trade_no || "").trim();
    const totalAmount = String(params.money || "").trim();
    const notifyPid = String(params.pid || "").trim();
    const tradeStatus = String(params.trade_status || "").trim();
    const tradeNo = String(params.trade_no || "").trim();

    if (!outTradeNo || !totalAmount || notifyPid !== pid) return res.status(400).send("fail");

    const ord = await Order.findOne({ outTradeNo }).lean();
    if (!ord) return res.status(200).send("success"); 
    if (parseFloat(ord.totalAmount).toFixed(2) !== parseFloat(totalAmount).toFixed(2)) return res.status(400).send("fail");

    const updates = {
      tradeNo,
      tradeStatus,
      notifiedAt: new Date().toISOString(),
      notifyIp: String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(),
      notifySnapshot: { ...params },
    };

    if (tradeStatus === "TRADE_SUCCESS") {
      updates.status = "PAID";
      if (!ord.creditedAt && ord.points && ord.userId) {
        // Atomic claim: only one request can set creditedAt
        const claimed = await Order.findOneAndUpdate(
          { outTradeNo, creditedAt: { $in: [null, undefined, ""] } },
          { $set: { creditedAt: new Date().toISOString() } },
          { new: false }
        );
        if (claimed) {
          const user = await findUserById(String(ord.userId));
          if (user) {
            ensureUserBillingFields(user);
            user.pointsBalance = Number(user.pointsBalance || 0) + Number(ord.points || 0);
            user.billingUpdatedAt = new Date().toISOString();
            appendBillingLog(user, {
              type: "recharge_aggregate",
              pointsAdded: Number(ord.points || 0),
              outTradeNo,
              tradeNo,
              pointsBalanceAfter: Number(user.pointsBalance || 0),
              at: user.billingUpdatedAt,
            });
            await saveUser(user);
          } else {
            updates.creditError = "user_not_found";
          }
        }
      }
    }

    await Order.findOneAndUpdate({ outTradeNo }, { $set: updates });
    res.status(200).send("success");
  } catch (err) {
    res.status(500).send("fail");
  }
};
app.get("/api/pay/alipay/notify", zpayNotifyHandler);
app.post("/api/pay/alipay/notify", zpayNotifyHandler);

app.use("/api/projects", requireAuth, withRequestContext);
app.use("/api/settings", requireAuth, withRequestContext);

app.get("/api/settings/models", async (req, res) => {
  const user = await findUserById(req.userId);
  const selectedTextModelId = String(user?.selectedModelId || "").trim();
  const fallbackTextModelId = resolveUserModel(user);
  const selectedImageModelId = resolveUserImageModelId(user);
  const selectedImageAspectRatio = resolveUserImageAspectRatio(user);

  // Append custom oioiapi option when it is fully configured and enabled
  const c = user?.customTextModel || {};
  const customApiKey = resolveCustomTextApiKey(c);
  const customTextOptions = [...MODEL_OPTIONS];
  if (c.enabled && customApiKey && String(c.modelName || "").trim()) {
    customTextOptions.push({
      modelId:   "custom:oioiapi",
      modelName: `自定义: oioiapi / ${String(c.modelName).trim()}`,
      hint:      "走你自己的 oioiapi 账户，不扣 Xflow 积分",
    });
  }

  const customOptionAvailable = customTextOptions.some((m) => m.modelId === "custom:oioiapi");
  const hasSelectedInOptions = customTextOptions.some((m) => m.modelId === selectedTextModelId);
  // Keep UI selection consistent with actual persisted selection, unless invalid/unavailable.
  let effectiveSelectedText = fallbackTextModelId;
  if (selectedTextModelId === "custom:oioiapi") {
    effectiveSelectedText = customOptionAvailable ? selectedTextModelId : fallbackTextModelId;
  } else if (hasSelectedInOptions) {
    effectiveSelectedText = selectedTextModelId;
  }

  res.json({
    textOptions: customTextOptions,
    selectedTextModelId: effectiveSelectedText,
    imageOptions: IMAGE_MODEL_OPTIONS.map((m) => ({ modelId: m.modelId, modelName: m.modelName })),
    selectedImageModelId,
    imageAspectRatioOptions: IMAGE_ASPECT_RATIO_OPTIONS,
    selectedImageAspectRatio,
    // backward compatible fields
    options: customTextOptions,
    selectedModelId: effectiveSelectedText,
  });
});

app.get("/api/settings/custom-text-model", async (req, res) => {
  try {
    const user = await findUserById(req.userId);
    if (!user) return res.status(404).json({ error: "user not found" });
    const c = user.customTextModel || {};
    const plainKey = resolveCustomTextApiKey(c);
    const hasApiKey = hasStoredCustomTextApiKey(c);
    const apiKeyMasked = plainKey ? maskApiKey(plainKey) : (hasApiKey ? "已保存（加密）" : "");
    res.json({
      ok: true,
      enabled:      Boolean(c.enabled),
      provider:     String(c.provider  || "oioiapi"),
      baseUrl:      effectiveOioiapiBaseUrl(),
      modelName:    String(c.modelName || ""),
      hasApiKey,
      apiKeyMasked,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/settings/custom-text-model", async (req, res) => {
  try {
    const user = await findUserById(req.userId);
    if (!user) return res.status(404).json({ error: "user not found" });

    const body = req.body || {};
    const clearApiKey = Boolean(body.clearApiKey);
    const enabled     = Boolean(body.enabled);
    const modelName   = String(body.modelName || "").trim();
    const newApiKey   = String(body.apiKey   || "").trim();

    if (!user.customTextModel) user.customTextModel = {};

    // provider & baseUrl are always fixed from env
    user.customTextModel.provider = "oioiapi";
    user.customTextModel.baseUrl  = effectiveOioiapiBaseUrl();

    if (clearApiKey) {
      user.customTextModel.apiKey   = "";
      user.customTextModel.enabled  = false;
      user.customTextModel.modelName = "";
    } else {
      if (newApiKey) user.customTextModel.apiKey = encryptCustomTextApiKey(newApiKey);
      user.customTextModel.modelName = modelName || String(user.customTextModel.modelName || "");

      const effectiveKey   = resolveCustomTextApiKey(user.customTextModel);
      const effectiveName  = String(user.customTextModel.modelName || "").trim();
      if (enabled && (!effectiveKey || !effectiveName)) {
        return res.status(400).json({ error: "启用自定义通道时需同时填写模型名称和 API Key" });
      }
      user.customTextModel.enabled = enabled;
    }

    // If the user currently has custom:oioiapi selected but is now disabling it, reset selection
    if (!user.customTextModel.enabled && user.selectedModelId === "custom:oioiapi") {
      user.selectedModelId = process.env.OPENAI_MODEL || MODEL_OPTIONS[0]?.modelId || "";
    }

    await saveUser(user);

    const plainKey = resolveCustomTextApiKey(user.customTextModel);
    const hasApiKey = hasStoredCustomTextApiKey(user.customTextModel);
    res.json({
      ok: true,
      enabled:      Boolean(user.customTextModel.enabled),
      provider:     "oioiapi",
      baseUrl:      effectiveOioiapiBaseUrl(),
      modelName:    String(user.customTextModel.modelName || ""),
      hasApiKey,
      apiKeyMasked: plainKey ? maskApiKey(plainKey) : (hasApiKey ? "已保存（加密）" : ""),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/settings/model", async (req, res) => {
  const body = req.body || {};
  const textModelId = body.textModelId || body.modelId;
  const imageModelId = body.imageModelId;
  const imageAspectRatio = body.imageAspectRatio;
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: "user not found" });
  const c = user.customTextModel || {};
  const customApiKey = resolveCustomTextApiKey(c);
  const isCustomText = textModelId === "custom:oioiapi"
    && Boolean(c.enabled)
    && customApiKey
    && String(c.modelName || "").trim();
  if (!isCustomText && !MODEL_OPTIONS.some((m) => m.modelId === textModelId)) {
    return res.status(400).json({ error: "invalid textModelId" });
  }
  if (imageModelId && !IMAGE_MODEL_OPTIONS.some((m) => m.modelId === imageModelId)) {
    return res.status(400).json({ error: "invalid imageModelId" });
  }
  if (imageAspectRatio && !IMAGE_ASPECT_RATIO_OPTIONS.includes(String(imageAspectRatio))) {
    return res.status(400).json({ error: "invalid imageAspectRatio" });
  }
  user.selectedModelId = textModelId;
  if (imageModelId) user.selectedImageModelId = imageModelId;
  else if (!user.selectedImageModelId) user.selectedImageModelId = IMAGE_MODEL_OPTIONS[0]?.modelId || "nano-banana2";
  if (imageAspectRatio) user.selectedImageAspectRatio = imageAspectRatio;
  else if (!user.selectedImageAspectRatio) user.selectedImageAspectRatio = resolveUserImageAspectRatio(user);
  await saveUser(user);
  res.json({
    ok: true,
    selectedTextModelId: user.selectedModelId,
    selectedImageModelId: resolveUserImageModelId(user),
    selectedImageAspectRatio: resolveUserImageAspectRatio(user),
    // backward compatible field
    selectedModelId: user.selectedModelId,
  });
});

app.get("/api/settings/billing", async (req, res) => {
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: "user not found" });
  if (ensureUserBillingFields(user)) await saveUser(user);
  res.json({
    ok: true,
    billing: {
      pointsBalance: Number(user.pointsBalance || 0),
      pointsSpent: Number(user.pointsSpent || 0),
      tokenUsage: user.tokenUsage || { prompt: 0, completion: 0, total: 0 },
      pricingUsdPer1m: {
        "gpt-5.1": modelPricingUsdPer1m("gpt-5.1"),
        "gpt-5.1-chat": modelPricingUsdPer1m("gpt-5.1-chat"),
        "gpt-5-nano": modelPricingUsdPer1m("gpt-5-nano"),
        "gpt-5.4": modelPricingUsdPer1m("gpt-5.4"),
        "deepseek-v3.2-thinking": modelPricingUsdPer1m("deepseek-v3.2-thinking"),
      },
      lowBalanceThreshold: getLowBalanceThreshold(),
      isLowBalance: Number(user.pointsBalance || 0) <= getLowBalanceThreshold(),
      lastUsage: user.lastUsage || null,
      billingUpdatedAt: user.billingUpdatedAt || null,
    },
  });
});

app.get("/api/settings/billing/logs", async (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page || 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize || 20))));
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: "user not found" });
  if (ensureUserBillingFields(user)) await saveUser(user);
  const logs = Array.isArray(user.billingLogs) ? user.billingLogs : [];
  const start = (page - 1) * pageSize;
  const rows = logs.slice(start, start + pageSize);
  res.json({
    ok: true,
    page,
    pageSize,
    total: logs.length,
    logs: rows,
  });
});

app.post("/api/settings/recharge", async (req, res) => {
  // Legacy simulated recharge (disable by default once Alipay is integrated)
  if (String(process.env.ALLOW_SIM_RECHARGE || "").trim() !== "1") {
    return res.status(410).json({ error: "模拟充值已关闭，请使用支付宝支付完成充值" });
  }
  const points = Math.floor(Number((req.body || {}).points || 0));
  if (!Number.isFinite(points) || points <= 0) {
    return res.status(400).json({ error: "points 必须是正整数" });
  }
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: "user not found" });
  ensureUserBillingFields(user);
  user.pointsBalance = Number(user.pointsBalance || 0) + points;
  user.billingUpdatedAt = new Date().toISOString();
  appendBillingLog(user, {
    type: "recharge",
    pointsAdded: points,
    pointsBalanceAfter: Number(user.pointsBalance || 0),
    at: user.billingUpdatedAt,
  });
  await saveUser(user);
  res.json({ ok: true, pointsBalance: user.pointsBalance, added: points });
});

app.post("/api/settings/change-password", async (req, res) => {
  const oldPassword = String((req.body || {}).oldPassword || "");
  const newPassword = String((req.body || {}).newPassword || "");
  if (!oldPassword) return res.status(400).json({ error: "oldPassword required" });
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "newPassword 至少 6 位" });
  }

  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: "user not found" });
  const okOld = await verifyUserPassword(oldPassword, user.password);
  if (!okOld) return res.status(401).json({ error: "旧密码不正确" });
  if (oldPassword === newPassword) {
    return res.status(400).json({ error: "新密码不能与旧密码相同" });
  }
  user.password = await hashUserPassword(newPassword);
  user.passwordUpdatedAt = new Date().toISOString();
  await saveUser(user);
  res.json({ ok: true });
});

app.get("/api/admin/status", requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, isAdmin: true });
});

app.get("/api/admin/models", requireAuth, requireAdmin, async (req, res) => {
  try {
    const customs = await CustomModels.findOne({ key: "singleton" }).lean() || { textModels: [], imageModels: [] };
    res.json({
      ok: true,
      data: {
        textModels: customs.textModels || [],
        imageModels: customs.imageModels || [],
        oioiapiBaseUrl: String(customs.oioiapiBaseUrl || "").trim(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/models", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { textModels, imageModels, oioiapiBaseUrl } = req.body || {};
    const normalizedOioi = String(oioiapiBaseUrl || "").trim().replace(/\/+$/g, "");
    if (normalizedOioi) {
      let parsed;
      try {
        parsed = new URL(normalizedOioi);
      } catch {
        return res.status(400).json({ error: "oioiapi 上游地址不是合法 URL，须以 http(s) 开头" });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).json({ error: "oioiapi 上游地址仅支持 http 或 https" });
      }
    }
    await CustomModels.findOneAndUpdate(
      { key: "singleton" },
      {
        textModels: Array.isArray(textModels) ? textModels : [],
        imageModels: Array.isArray(imageModels) ? imageModels : [],
        oioiapiBaseUrl: normalizedOioi,
      },
      { upsert: true, new: true }
    );
    await loadCustomModels();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const page = Math.max(1, Math.floor(Number(req.query.page || 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize || 20))));

  const query = {};
  if (q) {
    query.$or = [
      { id: { $regex: escapeRegex(q), $options: "i" } },
      { phone: { $regex: escapeRegex(q), $options: "i" } }
    ];
  }

  const total = await User.countDocuments(query);
  const skip = (page - 1) * pageSize;
  const usersRaw = await User.find(query)
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(pageSize)
    .lean();

  const users = usersRaw
    .map(u => flattenUser(u))
    .filter(u => u && u.id); // Ensure valid user objects

  res.json({
    ok: true,
    page,
    pageSize,
    total,
    users: users.map((u) => sanitizeUserForAdminList(u)),
  });
});

app.get("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "user not found" });
  ensureUserBillingFields(user);
  const logs = (user.billingLogs || []).slice(0, 80);
  res.json({
    ok: true,
    user: sanitizeUserForAdminList(user),
    tokenUsage: user.tokenUsage || { prompt: 0, completion: 0, total: 0 },
    lastUsage: user.lastUsage || null,
    billingLogs: logs,
  });
});

app.post("/api/admin/users/:id/points", requireAuth, requireAdmin, async (req, res) => {
  try {
    const reason = String((req.body || {}).reason || "").trim();
    if (reason.length < 2) return res.status(400).json({ error: "请填写调整原因（至少 2 字）" });
    const user = await findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
    applyAdminPointsAdjustment(user, (req.body || {}).delta, {
      adminUserId: req.user.id,
      adminPhone: req.user.phone,
      reason,
    });
    await saveUser(user);
    res.json({ ok: true, pointsBalance: Number(user.pointsBalance) });
  } catch (err) {
    const code = err.statusCode || 500;
    res.status(code).json({ error: err.message || "failed" });
  }
});

app.get("/api/admin/payments/alipay", requireAuth, requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const status = String(req.query.status || "").trim().toUpperCase();
  const credited = String(req.query.credited || "").trim();
  const page = Math.max(1, Math.floor(Number(req.query.page || 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize || 20))));

  const query = {};
  if (q) {
    query.$or = [
      { outTradeNo: { $regex: escapeRegex(q), $options: "i" } },
      { subject: { $regex: escapeRegex(q), $options: "i" } },
      { userId: { $regex: escapeRegex(q), $options: "i" } },
      { userPhone: { $regex: escapeRegex(q), $options: "i" } },
      { tradeNo: { $regex: escapeRegex(q), $options: "i" } }
    ];
  }
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = from;
    if (to) query.createdAt.$lte = to;
  }
  if (status) query.status = status;
  if (credited === "1") query.creditedAt = { $ne: null, $exists: true };
  if (credited === "0") query.creditedAt = { $in: [null, ""] };

  const total = await Order.countDocuments(query);
  const skip = (page - 1) * pageSize;
  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(pageSize)
    .lean();

  res.json({ ok: true, page, pageSize, total, orders });
});

app.post("/api/admin/payments/alipay/:outTradeNo/sync", requireAuth, requireAdmin, async (req, res) => {
  const result = await queryZpayOrder(req.params.outTradeNo);
  res.json(result);
});

app.post("/api/admin/payments/alipay/:outTradeNo/refund", requireAuth, requireAdmin, async (req, res) => {
  const result = await refundZpayOrder(req.params.outTradeNo);
  res.json(result);
});

app.post("/api/admin/backup", requireAuth, requireAdmin, async (req, res) => {
  try {
    await runMongoBackup();
    const dirs = fs.readdirSync(BACKUP_DIR)
      .filter(d => d.startsWith("backup_"))
      .sort()
      .reverse();
    res.json({ ok: true, message: `Backup completed. Total backups: ${dirs.length}`, latest: dirs[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/backups", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json({ backups: [] });
    const dirs = fs.readdirSync(BACKUP_DIR)
      .filter(d => d.startsWith("backup_") && fs.statSync(path.join(BACKUP_DIR, d)).isDirectory())
      .sort()
      .reverse();
    const backups = dirs.map(d => {
      const manifestPath = path.join(BACKUP_DIR, d, "manifest.json");
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")); } catch {}
      return { name: d, ...manifest };
    });
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/payments/alipay/summary", requireAuth, requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const status = String(req.query.status || "").trim().toUpperCase();
  const credited = String(req.query.credited || "").trim();

  const query = {};
  if (q) {
    query.$or = [
      { outTradeNo: { $regex: escapeRegex(q), $options: "i" } },
      { subject: { $regex: escapeRegex(q), $options: "i" } },
      { userId: { $regex: escapeRegex(q), $options: "i" } },
      { userPhone: { $regex: escapeRegex(q), $options: "i" } },
      { tradeNo: { $regex: escapeRegex(q), $options: "i" } }
    ];
  }
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = from;
    if (to) query.createdAt.$lte = to;
  }
  if (status) query.status = status;
  if (credited === "1") query.creditedAt = { $ne: null, $exists: true };
  if (credited === "0") query.creditedAt = { $in: [null, ""] };

  const orders = await Order.find(query).lean();

  let merchantInfo = null;
  try {
    merchantInfo = await zpayApiRequest("query");
  } catch (e) {
    console.error("Fetch Z-Pay merchant info failed:", e.message);
  }
  
  let amountSum = 0;
  let pointsSum = 0;
  let paidCount = 0;
  let creditedCount = 0;
  const byStatus = {};
  const byChannel = {};

  for (const o of orders) {
    const st = String(o.status || "UNKNOWN");
    byStatus[st] = (byStatus[st] || 0) + 1;
    const ch = String(o.channel || "UNKNOWN");
    byChannel[ch] = (byChannel[ch] || 0) + 1;

    const amt = Number(o.totalAmount || 0);
    if (Number.isFinite(amt)) amountSum += amt;
    const pts = Number(o.points || 0);
    if (Number.isFinite(pts)) pointsSum += pts;
    if (st === "PAID") paidCount += 1;
    if (o.creditedAt) creditedCount += 1;
  }

  res.json({
    ok: true,
    totalOrders: orders.length,
    paidCount,
    creditedCount,
    amountSum: Math.round(amountSum * 100) / 100,
    pointsSum,
    byStatus,
    byChannel,
    filters: { q, from, to, status, credited },
    merchantInfo
  });
});

app.get("/api/admin/payments/alipay/export.csv", requireAuth, requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const status = String(req.query.status || "").trim().toUpperCase();
  const credited = String(req.query.credited || "").trim();

  const query = {};
  if (q) {
    query.$or = [
      { outTradeNo: { $regex: escapeRegex(q), $options: "i" } },
      { subject: { $regex: escapeRegex(q), $options: "i" } },
      { userId: { $regex: escapeRegex(q), $options: "i" } },
      { userPhone: { $regex: escapeRegex(q), $options: "i" } },
      { tradeNo: { $regex: escapeRegex(q), $options: "i" } }
    ];
  }
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = from;
    if (to) query.createdAt.$lte = to;
  }
  if (status) query.status = status;
  if (credited === "1") query.creditedAt = { $ne: null, $exists: true };
  if (credited === "0") query.creditedAt = { $in: [null, ""] };

  const orders = await Order.find(query).sort({ createdAt: -1 }).lean();

  const headers = [
    "createdAt", "outTradeNo", "channel", "userPhone", "userId", "planId", "subject",
    "totalAmount", "points", "status", "tradeStatus", "tradeNo", "buyerLogonId",
    "gmtPayment", "creditedAt", "creditError", "notifiedAt", "settledAt", "settleFrom", "notifyIp"
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[\",\n\r]/.test(s)) return `"${s.replace(/\"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of orders) {
    lines.push(headers.map((h) => esc(r[h])).join(","));
  }
  const csv = "\uFEFF" + lines.join("\n");

  const name = `alipay_orders_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(csv);
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const disabled = (req.body || {}).accountDisabled;
  if (typeof disabled !== "boolean") return res.status(400).json({ error: "accountDisabled 须为 true/false" });
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "user not found" });
  user.accountDisabled = disabled;
  await saveUser(user);
  res.json({ ok: true, user: sanitizeUserForAdminList(user) });
});

app.post("/api/settings/chat", async (req, res) => {
  try {
    const user = await findUserById(req.userId);
    if (!user) return res.status(404).json({ error: "user not found" });

    const modelId = resolveUserModel(user);
    const message = String((req.body || {}).message || "").trim();
    const visualStyle = String((req.body || {}).visualStyle || "").trim();
    const imageMode = Boolean((req.body || {}).imageMode);
    const historyRaw = Array.isArray((req.body || {}).history) ? req.body.history : [];
    if (!message) return res.status(400).json({ error: "message required" });

    // Help / capabilities
    if (isChatHelpCommand(message)) {
      return res.json({ ok: true, modelId, reply: getChatCapabilitiesText() });
    }

    // 对话框内通用生图（不绑定章节资产）
    {
      const imgCmd = resolveChatImageIntent(message, imageMode);
      if (imgCmd) {
        if (!imgCmd.prompt) return res.status(400).json({ error: "生图提示词不能为空" });
        const generated = await generateChatImageForAssistant({
          userId: req.userId,
          prompt: imgCmd.prompt,
          ratioOverride: imgCmd.ratio,
        });
        return res.json({ ok: true, modelId, mode: "image", reply: generated.reply, image: generated.imageInfo });
      }
    }

    // ---------------------------------------------
    // Project-aware chat commands (file workspace)
    // ---------------------------------------------
    // 支持在“通用聊天(A)”里直接读取本地项目并执行：提取某项目第N章大纲
    // 例如：提取Test项目第二集大纲 / 提取 Test 第2章大纲
    {
      const cmd = parseProjectOutlineCommand(message);
      if (cmd) {
        const { projectNameLike, chapterNo } = cmd;
        const resolved = resolveProjectByNameLike(req.userId, projectNameLike);
        if (!resolved) {
          return res.json({
            ok: true,
            modelId,
            reply: `未找到项目「${projectNameLike}」。请先在“项目列表”确认名称，或直接提供项目ID（形如 p_xxx）。`,
          });
        }
        const { projectId, settings } = resolved;
        const chapterId = `c_${chapterNo}`;
        const chapterText = safeRead(chapterTextPath(req.userId, projectId, chapterId));
        if (!String(chapterText || "").trim()) {
          return res.json({
            ok: true,
            modelId,
            reply: `项目「${settings.name}」未找到第${chapterNo}章内容（${chapterId}）。请先在项目中完成拆章或确认章节是否存在。`,
          });
        }

        const stage1 = await runStage1Analysis({
          projectName: settings.name,
          visualStyle: visualStyle || settings.visualStyle || "",
          scriptText: chapterText,
          modelId,
        });
        const { itemsMd, storylineMd } = await generateItemsAndStoryline({
          chapterText,
          analysisText: stage1.rawAnalysisMd,
          projectName: settings.name,
          visualStyle: visualStyle || settings.visualStyle || "",
          chapterRangeLabel: `第${chapterNo}章`,
          modelId,
        });

        const reply = [
          `已为项目「${settings.name}」提取第${chapterNo}章大纲（人物/场景/物品/故事线）。`,
          "",
          stage1.rawAnalysisMd,
          "",
          itemsMd,
          "",
          storylineMd,
        ]
          .filter(Boolean)
          .join("\n");

        return res.json({ ok: true, modelId, reply });
      }
    }

    const history = historyRaw
      .map((x) => ({
        role: String(x?.role || "").trim(),
        content: String(x?.content || "").trim(),
      }))
      .filter((x) => (x.role === "user" || x.role === "assistant") && x.content)
      .slice(-20);

    const system = [
      "你是 Xflow 工作台内置 AI 对话助手。",
      "请使用中文回答，内容简洁、可执行，优先结合小说拆解与资产生产场景给建议。",
      "如果用户请求不清晰，先用一句话澄清再继续回答。",
      "提示：用户可输入「帮助」查看你支持的对话指令与示例。",
      visualStyle ? `当前视觉风格偏好：${visualStyle}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const messages = [{ role: "system", content: system }, ...history, { role: "user", content: message }];
    const reply = await callLlm(messages, modelId, { temperature: 0.5, maxAttempts: 3 });
    if (!reply) return res.status(502).json({ error: USER_FACING_UPSTREAM });

    res.json({ ok: true, modelId, reply: String(reply).trim() });
  } catch (err) {
    console.error("[settings/chat]", err);
    res.status(500).json({ error: userFacingSettingsChatError(err) });
  }
});

function isChatHelpCommand(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  return /^(help|\/help|h|\/h)$/i.test(s) || /(帮助|能做什么|你会什么|指令|命令|usage|怎么用)/i.test(s);
}

function splitImagePromptAndRatio(rawPrompt) {
  let prompt = String(rawPrompt || "").trim();
  if (!prompt) return { prompt: "", ratio: "" };
  const ratioHit =
    prompt.match(/(?:比例|ratio)\s*[：:=]?\s*(1:1|16:9|9:16)/i) || prompt.match(/\b(1:1|16:9|9:16)\b/);
  const ratio = ratioHit ? String(ratioHit[1] || "").trim() : "";
  if (ratio) {
    prompt = prompt
      .replace(new RegExp(`(?:比例|ratio)\\s*[：:=]?\\s*${ratio.replace(":", "\\:")}`, "ig"), "")
      .replace(new RegExp(`\\b${ratio.replace(":", "\\:")}\\b`, "g"), "")
      .trim();
  }
  return { prompt: prompt.trim(), ratio: ratio || "" };
}

function parseChatImageCommand(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  let prompt = "";
  const r1 = s.match(/^\/(?:img|image)\s+([\s\S]+)$/i);
  if (r1) prompt = String(r1[1] || "").trim();
  if (!prompt) {
    const r2 = s.match(/^(?:帮我)?(?:生成图片|生图|画图)\s*[：:]\s*([\s\S]+)$/i);
    if (r2) prompt = String(r2[1] || "").trim();
  }
  if (!prompt) {
    const r3 = s.match(/^(?:帮我)?(?:生成|画)\s*(?:一张|1张)?\s*图\s*[：:]\s*([\s\S]+)$/i);
    if (r3) prompt = String(r3[1] || "").trim();
  }
  if (!prompt) return null;
  const out = splitImagePromptAndRatio(prompt);
  if (!out.prompt) return null;
  return out;
}

/** 显式 /img 等优先；勾选生图模式时整段正文作提示词（不与「提取项目第N章大纲」冲突） */
function resolveChatImageIntent(message, imageMode) {
  const msg = String(message || "").trim();
  if (parseProjectOutlineCommand(msg)) return null;
  const fromCmd = parseChatImageCommand(message);
  if (fromCmd) return fromCmd;
  if (!imageMode || !msg) return null;
  const out = splitImagePromptAndRatio(msg);
  if (!out.prompt) return null;
  return out;
}

function buildChatImageReply({ prompt, imageInfo, pointsCost }) {
  const modelName = imageInfo?.imageModelName || "Nano banana2（最强画质·推荐）";
  const ratio = imageInfo?.aspectRatio || "-";
  const costLine = Number(pointsCost || 0) > 0 ? `本次扣费：${Number(pointsCost)} 积分。` : "本次扣费：0 积分。";
  return [
    `已为你生成图片（模型：${modelName}，比例：${ratio}）。`,
    costLine,
    "",
    `![${String(prompt || "生成图片").slice(0, 40)}](${imageInfo?.url || ""})`,
  ].join("\n");
}

async function generateChatImageForAssistant({ userId, prompt, ratioOverride }) {
  const user = await findUserById(userId);
  if (!user) throw new Error("user not found");
  const conf = getToapisImageConfig(user);
  if (!conf.apiKey) throw new Error("未配置 TOAPIS_API_KEY，无法执行图片生成");

  const ratio = IMAGE_ASPECT_RATIO_OPTIONS.includes(String(ratioOverride || "").trim())
    ? String(ratioOverride).trim()
    : conf.size;
  const fixedPointsCost = resolveImageModelPointsCost(conf.imageModelId);
  if (fixedPointsCost > 0) {
    await assertUserHasImagePoints(userId, fixedPointsCost);
  }

  const created = await createToapisImageTask({
    apiKey: conf.apiKey,
    baseUrl: conf.baseUrl,
    model: conf.model,
    prompt,
    size: ratio,
    resolution: conf.resolution,
    imageUrls: [],
  });
  const statusPayload = await pollToapisImageTask({
    apiKey: conf.apiKey,
    baseUrl: conf.baseUrl,
    taskId: created.id,
  });
  const remoteUrl = pickToapisResultUrl(statusPayload);
  if (!remoteUrl) throw new Error("生成成功 but no image URL");

  const local = await downloadToChatImage({ imageUrl: remoteUrl, userId });
  const imageInfo = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    url: local.publicUrl,
    remoteUrl,
    model: conf.model,
    imageModelId: conf.imageModelId,
    imageModelName: resolveImageModelNameById(conf.imageModelId),
    aspectRatio: ratio,
    pointsCost: fixedPointsCost,
    prompt,
    taskId: created.id,
    createdAt: new Date().toISOString(),
  };

  try {
    if (fixedPointsCost > 0) {
      await recordUserImageUsageAndDeductPoints({
        userId,
        imageModelId: conf.imageModelId,
        pointsCost: fixedPointsCost,
        aspectRatio: ratio,
        projectId: "",
        chapterId: "",
        taskId: created.id,
      });
    }
  } catch (err) {
    try {
      if (local?.absPath && fs.existsSync(local.absPath)) fs.unlinkSync(local.absPath);
    } catch { }
    throw err;
  }

  const reply = buildChatImageReply({ prompt, imageInfo, pointsCost: fixedPointsCost });
  return { reply, imageInfo, pointsCost: fixedPointsCost };
}

function getChatCapabilitiesText() {
  return [
    "## Xflow 对话助手｜你可以让我做什么",
    "",
    "### 1) 提取指定项目的指定章/集大纲（无需粘贴原文）",
    "前提：该项目已在工作台里完成拆章，并存在对应章节内容。",
    "可用指令（任选其一）：",
    "- 提取<项目名>第N章大纲",
    "- 提取<项目名>第N集大纲",
    "",
    "示例：",
    "- 提取Test项目第2章大纲",
    "- 提取Test项目第二集大纲",
    "",
    "输出包含：人物/场景分析（阶段1报告）+ 物品清单 + 故事线。",
    "",
    "### 2) 通用咨询（不读取项目文件）",
    "- 提示词怎么写更稳？",
    "- 分镜脚本怎么改更有动态？台词怎么嵌入动作节点？",
    "",
    "### 3) 在 AI 对话框直接生图（不绑定章节资产）",
    "- 勾选输入框下方「生图模式」后，整段文字作为画面提示词发送即可（仍可用 `比例 16:9` / `1:1` 等指定画幅）。",
    "- 或不勾选时：`/img 傍晚古风女侠，手持长刀，风吹衣摆`",
    "- `生成图片：赛博朋克街道夜雨，霓虹反光，比例16:9`",
    "- `生图：治愈系卡通猫咪，比例1:1`",
    "说明：生图模型可在设置里选择；Nano banana2（最强画质·推荐）成功扣 30 积分，豆包 Seedream 5.0 成功扣 20 积分，失败不扣（以当前所选模型为准）。",
    "",
    "### 4) 约束与提示",
    "- 如果回复提示“未找到项目/章节为空”，通常是项目未拆章或章节号不对。",
    "- 你也可以先发：项目名 + 想处理的章号，我会告诉你该用哪条指令。",
  ].join("\n");
}

function parseProjectOutlineCommand(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  // 兼容：“提取Test项目的第二集/第2章/第二章…大纲”
  const m =
    s.match(/提取\s*([^\s，。]+?)\s*(?:项目)?\s*(?:的)?\s*第\s*([0-9]+)\s*(?:章|集|回|话|节)\s*大纲/i) ||
    s.match(/提取\s*([^\s，。]+?)\s*(?:项目)?\s*(?:的)?\s*第\s*(二|三|四|五|六|七|八|九|十|一)\s*(?:章|集|回|话|节)\s*大纲/i) ||
    s.match(/提取\s*([^\s，。]+?)\s*(?:项目)?\s*(?:的)?\s*(第一|第二|第三|第四|第五|第六|第七|第八|第九|第十)\s*(?:章|集|回|话|节)\s*大纲/i);
  if (!m) return null;
  const projectNameLike = String(m[1] || "").trim();
  if (!projectNameLike) return null;
  const rawNo = String(m[2] || "").trim();
  const map = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    第一: 1,
    第二: 2,
    第三: 3,
    第四: 4,
    第五: 5,
    第六: 6,
    第七: 7,
    第八: 8,
    第九: 9,
    第十: 10,
  };
  const chapterNo = Number.isFinite(Number(rawNo)) ? Number(rawNo) : map[rawNo];
  if (!chapterNo || chapterNo < 1) return null;
  return { projectNameLike, chapterNo };
}

async function resolveProjectByNameLike(userId, projectNameLike) {
  const key = String(projectNameLike || "").trim();
  if (!key) return null;
  const list = await Project.find({ userId }).lean();
  let hit = list.find((p) => String(p.name || "").toLowerCase() === key.toLowerCase());
  if (!hit) hit = list.find((p) => String(p.name || "").toLowerCase().includes(key.toLowerCase()));
  if (!hit) return null;
  return { projectId: hit.id, settings: hit };
}

app.post("/api/settings/chat/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    const user = await findUserById(req.userId);
    if (!user) {
      writeSse(res, { type: "error", message: "user not found" });
      return res.end();
    }
    const textConfig = resolveUserTextConfig(user);
    const textModelId = textConfig.isCustom ? textConfig.modelId : resolveUserModel(user);
    const message = String((req.body || {}).message || "").trim();
    const visualStyle = String((req.body || {}).visualStyle || "").trim();
    const imageMode = Boolean((req.body || {}).imageMode);
    const historyRaw = Array.isArray((req.body || {}).history) ? req.body.history : [];
    if (!message) {
      writeSse(res, { type: "error", message: "message required" });
      return res.end();
    }

    // 对话框内通用生图（不绑定章节资产）
    {
      const imgCmd = resolveChatImageIntent(message, imageMode);
      if (imgCmd) {
        if (!imgCmd.prompt) {
          writeSse(res, { type: "error", message: "生图提示词不能为空" });
          return res.end();
        }
        writeSse(res, {
          type: "image_wait",
          message: "图片生成中，请稍候（复杂画面可能需要数分钟）…",
        });
        const generated = await generateChatImageForAssistant({
          userId: req.userId,
          prompt: imgCmd.prompt,
          ratioOverride: imgCmd.ratio,
        });
        writeSse(res, { type: "meta", modelId: textModelId, mode: "image" });
        writeSse(res, { type: "delta", delta: generated.reply });
        writeSse(res, { type: "done" });
        return res.end();
      }
    }

    const key = textConfig.apiKey;
    if (!key) {
      writeSse(res, { type: "error", message: textConfig.isCustom ? "自定义通道 API Key 未配置" : "OPENAI_API_KEY missing" });
      return res.end();
    }
    const base = textConfig.baseUrl;
    const url = /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

    if (!textConfig.skipBilling) {
      await assertUserHasPoints(req.userId);
    }

    const history = historyRaw
      .map((x) => ({
        role: String(x?.role || "").trim(),
        content: String(x?.content || "").trim(),
      }))
      .filter((x) => (x.role === "user" || x.role === "assistant") && x.content)
      .slice(-20);

    const system = [
      "你是 Xflow 工作台内置 AI 对话助手。",
      "请使用中文回答，内容简洁、可执行，优先结合小说拆解与资产生产场景给建议。",
      "如果用户请求不清晰，先用一句话澄清再继续回答。",
      visualStyle ? `当前视觉风格偏好：${visualStyle}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const messages = [{ role: "system", content: system }, ...history, { role: "user", content: message }];

    // For custom channel disable provider fallback; for built-in use the existing fallback helper
    let bodyStream, streamBillingModelId;
    if (textConfig.isCustom) {
      bodyStream = await callLlmStream({ messages, model: textConfig.modelId, temperature: 0.5, apiKey: key, url });
      streamBillingModelId = textConfig.modelId;
    } else {
      const result = await callLlmStreamWithOptionalModelFallback({
        messages,
        requestedModel: textModelId,
        temperature: 0.5,
        apiKey: key,
        url,
      });
      bodyStream = result.body;
      streamBillingModelId = result.model;
    }

    writeSse(res, { type: "meta", modelId: streamBillingModelId });

    const reader = bodyStream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let usageCaptured = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse full SSE blocks, keep remainder in buffer.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const chunks = parseSseLinesToJsonChunks(part + "\n\n");
        for (const c of chunks) {
          if (c.done) {
            if (usageCaptured) {
              if (!textConfig.skipBilling) {
                await recordUserUsageAndDeductPoints(req.userId, usageCaptured, streamBillingModelId);
              } else {
                await recordExternalUsageTrace(req.userId, { provider: "oioiapi", modelId: streamBillingModelId }).catch(() => {});
              }
            }
            writeSse(res, { type: "done" });
            res.end();
            return;
          }
          if (!c.json) continue;
          let parsed = null;
          try {
            parsed = JSON.parse(c.json);
          } catch {
            continue;
          }
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            writeSse(res, { type: "delta", delta });
          }
          if (parsed?.usage && typeof parsed.usage === "object") {
            usageCaptured = parsed.usage;
          }
        }
      }
    }

    if (usageCaptured) {
      if (!textConfig.skipBilling) {
        recordUserUsageAndDeductPoints(req.userId, usageCaptured, streamBillingModelId);
      } else {
        recordExternalUsageTrace(req.userId, { provider: "oioiapi", modelId: streamBillingModelId }).catch(() => {});
      }
    }
    writeSse(res, { type: "done" });
    res.end();
  } catch (err) {
    console.error("[settings/chat/stream]", err);
    writeSse(res, { type: "error", message: userFacingSettingsChatError(err) });
    res.end();
  }
});

// -----------------------------
// Project-based workspace APIs
// -----------------------------



function splitIntoChapters(novelText) {
  const text = (novelText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  // 拆章锚点：
  // - 支持：第1章/第一章/第 1 集/第一集/第1话/第1幕/第1卷/第1回/第1篇/第1部/第1册/第1辑...
  // - 支持包裹符号与常见后缀： 【】 () （） : ： - —— 等
  // - 兼容“序章/楔子/引子/序/尾声/后记/番外”等独立章节标题
  // 说明：与下方 strip 正则保持同步
  const marker = "章节回卷集话篇部幕册辑";
  const chapterNum = "(?:[0-9]+|[零一二三四五六七八九十百千万两]+)";
  const headCore = `第\\s*${chapterNum}\\s*[${marker}]`;
  const headWrapped = `(?:[【\\[(（]\\s*)?(?:${headCore})(?:\\s*[】\\])）])?`;
  const headTail = `(?:[\\s：:、,，\\-—–][^\\n]*)?`;
  const specialHead = "(?:序章|楔子|引子|序|尾声|后记|番外)(?:\\s*[：:、,，\\-—–].*)?";
  const chapterHeadLine = `(?:${headWrapped}${headTail}|${specialHead})`;
  const chapterRegex = new RegExp(`(^|\\n)\\s*(${chapterHeadLine})\\s*(?=\\n)`, "gi");
  const stripChapterHeadRe = new RegExp(`^\\s*(${chapterHeadLine})\\s*\\n?`, "i");

  const matches = [];
  let m;
  while ((m = chapterRegex.exec(text))) {
    const idx = m.index + (m[1] === "\n" ? 1 : 0);
    const heading = String(m[2] || "").trim();
    matches.push({ index: idx, title: heading || `第${matches.length + 1}章` });
  }

  if (matches.length === 0) {
    // fallback: split by long blank lines
    const parts = text
      .split(/\n{3,}/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length <= 1) {
      const smart = smartSplitNoMarkers(text);
      if (smart.length) return smart;
      return [{ title: "第一章", content: text }];
    }
    return parts.map((content, i) => ({ title: `第${i + 1}章`, content }));
  }

  matches.sort((a, b) => a.index - b.index);
  const chapters = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const chapterContent = text.slice(start, end).replace(stripChapterHeadRe, "").trim();
    chapters.push({
      title: (matches[i].title || "").replace(/\s+/g, " ").trim() || `第${i + 1}章`,
      content: chapterContent || "",
    });
  }
  return chapters;
}

function smartSplitNoMarkers(rawText) {
  const text = String(rawText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const TARGET_MIN = 2500;
  const TARGET_MAX = 4500;
  const HARD_MIN = 1200;
  const HARD_MAX = 6500;

  const paragraphs = text
    .split(/\n{2,}/g)
    .map((p) => p.replace(/\n+/g, "\n").trim())
    .filter(Boolean);

  // If no blank lines at all, fallback to splitting by sentence-ish boundaries.
  const units =
    paragraphs.length > 1
      ? paragraphs
      : text
        .split(/(?<=[。！？!?])\s*\n+/g)
        .map((s) => s.trim())
        .filter(Boolean);

  if (!units.length) return [];

  const boundaryRe = [
    { re: /(次日|翌日|第二天|隔天|三天后|数日后|半月后|一月后|多年后|不久后|片刻后)/, w: 4 },
    { re: /(与此同时|同一时间|另一边|另一头|转眼间|忽然|忽而|忽地)/, w: 2 },
    { re: /(回到|来到|走进|进入|离开|抵达|赶到|回府|回宫|回家|回营|入城|出城)/, w: 2 },
    { re: /(随后|最终|至此|于是|结果|终究|散去|落幕|告一段落)/, w: 1 },
    { re: /(——|—{2,})/, w: 2 },
  ];

  function unitScore(u) {
    const s = String(u || "");
    let score = 0;
    for (const it of boundaryRe) if (it.re.test(s)) score += it.w;
    // Prefer boundaries that end with strong punctuation.
    if (/[。！？!?]$/.test(s)) score += 1;
    return score;
  }

  const res = [];
  let buf = [];
  let bufLen = 0;

  function flush(force) {
    const content = buf.join("\n\n").trim();
    if (!content) return;
    if (!force && content.length < HARD_MIN) return;
    res.push({ title: `第${res.length + 1}章`, content });
    buf = [];
    bufLen = 0;
  }

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const uLen = u.length;

    // If current buffer is already too large, cut immediately.
    if (bufLen >= HARD_MAX) {
      flush(true);
    }

    buf.push(u);
    bufLen += uLen + 2;

    if (bufLen < HARD_MIN) continue;

    // Lookahead: decide whether to cut here.
    const nearTarget = bufLen >= TARGET_MIN && bufLen <= TARGET_MAX;
    const overTarget = bufLen > TARGET_MAX;
    if (!nearTarget && !overTarget) continue;

    const s = u;
    const score = unitScore(s);

    // Cut rules:
    // - If near target and score indicates a likely boundary, cut.
    // - If over target, cut even with low score, but slightly prefer better boundaries.
    if ((nearTarget && score >= 2) || (overTarget && (score >= 1 || bufLen >= HARD_MAX - 200))) {
      flush(true);
    }
  }

  if (buf.length) flush(true);

  // Merge too-short tail into previous.
  if (res.length >= 2) {
    const last = res[res.length - 1];
    if ((last.content || "").length < HARD_MIN) {
      res[res.length - 2].content = `${res[res.length - 2].content}\n\n${last.content}`.trim();
      res.pop();
    }
  }

  // Re-title after merges.
  return res.map((c, idx) => ({ title: `第${idx + 1}章`, content: c.content || "" }));
}

function extractSectionBlock(markdown, headingText) {
  // headingText should be like "### 3. 人物清单" or "### 4. 场景清单"
  const startIdx = markdown.indexOf(headingText);
  if (startIdx < 0) return "";
  const rest = markdown.slice(startIdx + headingText.length);

  const nextHeadingMatch = rest.match(/\n###\s*\d+\.?\s*.+\n/g);
  if (nextHeadingMatch && nextHeadingMatch.index >= 0) {
    return (headingText + rest.slice(0, nextHeadingMatch.index)).trim();
  }
  return (headingText + rest).trim();
}

/** 从整份分析报告中截取「人物清单」与「场景清单」，避免两者都回退成全文导致内容相同 */
function extractSectionBetween(markdown, startMarkers, endMarkers) {
  if (!markdown) return "";
  let bestStart = -1;
  let bestMarker = "";
  for (const m of startMarkers) {
    const i = markdown.indexOf(m);
    if (i >= 0 && (bestStart < 0 || i < bestStart)) {
      bestStart = i;
      bestMarker = m;
    }
  }
  if (bestStart < 0) return "";
  const rest = markdown.slice(bestStart + bestMarker.length);
  let cut = rest.length;
  for (const end of endMarkers) {
    const j = rest.indexOf(end);
    if (j >= 0 && j < cut) cut = j;
  }
  return (bestMarker + rest.slice(0, cut)).trim();
}

function extractCharactersSection(analysisText) {
  const starts = [
    "### 3. 人物清单",
    "### 人物清单",
    "## 3. 人物清单",
    "## 人物清单",
    "#### 3. 人物清单",
  ];
  const ends = [
    "\n### 4. 场景清单",
    "\n### 4.",
    "\n### 场景清单",
    "\n## 4. 场景清单",
    "\n## 4.",
    "\n### 5.",
    "\n### 5. 人物与场景关系图",
    "\n## 5.",
  ];
  let s = extractSectionBetween(analysisText, starts, ends);
  if (s) return s;
  s = extractSectionBlock(analysisText, "### 3. 人物清单") || extractSectionBlock(analysisText, "### 人物清单");
  return s || "";
}

function extractScenesSection(analysisText) {
  const starts = [
    "### 4. 场景清单",
    "### 场景清单",
    "## 4. 场景清单",
    "## 场景清单",
    "#### 4. 场景清单",
  ];
  const ends = [
    "\n### 5.",
    "\n### 5. 人物与场景关系图",
    "\n## 5.",
    "\n### 6.",
    "\n### 6. 总结",
    "\n## 6.",
  ];
  let s = extractSectionBetween(analysisText, starts, ends);
  if (s) return s;
  s = extractSectionBlock(analysisText, "### 4. 场景清单") || extractSectionBlock(analysisText, "### 场景清单");
  return s || "";
}

async function generateItemsAndStoryline({
  chapterText,
  analysisText,
  projectName,
  visualStyle,
  chapterRangeLabel,
  modelId,
}) {
  const vStyle = (visualStyle || "").trim();
  const pName = (projectName || "").trim() || "未知小说";
  const rangeLabel = (chapterRangeLabel || "第X章").trim();

  const toolPolishFull = safeRead(SKILLS.toolPolish);
  const storyLineFull = safeRead(SKILLS.storyline);

  const toolPolishSnippet = sliceSkillText(toolPolishFull, "## 第三部分：结构描述规范");
  const storyLineSnippet = sliceSkillText(storyLineFull, "## 输出格式");

  // 1) Define Extract visible prop names (items) from chapter text
  const extractItemsSystem = [
    "你是道具/物品提取助手，只从章节原文中抽取“可被镜头拍到”的物品/道具名称。",
    "输出严格 JSON：{ \"items\": [ { \"name\": \"...\" } ] }，不要输出任何解释文字。",
    "规则：",
    "1) 最多 6 个，去重；name 必须是具体名词短语（2-12字），禁止抽象词、情绪词、动作短语。",
    "2) 优先抽取：信物/证据/关键器物/武器/钱袋/玉佩/文书/药瓶等可见物；不要抽取泛化词（如“东西”“物品”“行李”）。",
    "3) 严禁把人物名、地名、时间词当成物品。",
  ].join("\n");

  const extractItemsUser = `小说名：${pName}\n视觉风格：${vStyle}\n章节范围：${rangeLabel}\n\n章节原文：\n${chapterText}\n\n参考分析：\n${analysisText}`;

  const extractItemsPromise = (async () => {
    let itemsText = null;
    try {
      itemsText = await callLlm(
        [
          { role: "system", content: extractItemsSystem },
          { role: "user", content: extractItemsUser },
        ],
        modelId
      );
    } catch (err) {
      console.error("generateItemsAndStoryline: extract items failed:", err?.message || err);
    }
    let names = [];
    if (itemsText) {
      const parsed = parseJsonFromText(itemsText, { items: [] });
      names = Array.isArray(parsed?.items) ? parsed.items.map((x) => String(x.name || "").trim()).filter(Boolean) : [];
    }
    if (!names || names.length === 0) {
      const lines = chapterText.split("\n").map((l) => l.trim()).filter(Boolean);
      const guesses = [];
      for (const l of lines) {
        const m = l.match(/(拿起|拿着|手里|背着|递给|交给|掏出|拔出|握住|打开|举起|取出)?([^，。；,.]{2,20})/);
        if (m && m[2] && !/人|说|看/.test(m[2])) guesses.push(m[2].trim());
        if (guesses.length >= 4) break;
      }
      names = Array.from(new Set(guesses)).slice(0, 4);
    }
    return names;
  })();

  // 3) Define Storyline generation
  const storySystem = [
    "你必须严格遵循 stroy-line-SKLII 的输出格式与规范。",
    "不要输出解释文本，不要输出 Markdown 代码块（不要使用 ```）。",
    "只输出故事线文本本身。",
    storyLineSnippet,
  ].join("\n");

  const storyUser = `小说名：${pName}\n章节范围：${rangeLabel}\n\n章节原文：\n${chapterText}\n\n参考分析（可用于人物/场景提示词，但不要复述分析）：\n${analysisText}`;

  const storylinePromise = (async () => {
    let text = null;
    try {
      text = await callLlm(
        [
          { role: "system", content: storySystem },
          { role: "user", content: storyUser },
        ],
        modelId
      );
    } catch (err) {
      console.error("generateItemsAndStoryline: storyline failed:", err?.message || err);
    }
    return text;
  })();

  // Execute extraction and storyline in parallel
  const [itemNames, storylineText] = await Promise.all([extractItemsPromise, storylinePromise]);

  // 2) Tool-polish each item name into a prompt paragraph (Parallelized)
  const toolPolishSystem = [
    "你必须严格遵循 tool-polish-SKILL 的输出规范。",
    "输出必须只包含“一个连续中文段落”（允许标点），不要出现标题、序号、换行、列表符号。",
    "段落内容只能描述道具本身，不得包含人物、手部、场景、环境、功能说明或情绪词。",
    "长度 80-180 字，强调外观结构+材质+颜色+细节+新旧磨损+尺度感。",
    toolPolishSnippet,
  ].join("\n");

  const itemPromptPairs = await Promise.all(
    itemNames.slice(0, 6).map(async (itemName) => {
      const userPrompt = `输入风格：${vStyle || "写实风"}\n道具名称：${itemName}\n\n请输出道具可视化提示词段落（80-200字）。`;
      let polished = null;
      try {
        polished = await callLlm(
          [
            { role: "system", content: toolPolishSystem },
            { role: "user", content: userPrompt },
          ],
          modelId
        );
      } catch (err) {
        console.error("generateItemsAndStoryline: polish item failed:", err?.message || err);
      }
      let paragraph = (polished || "").trim().replace(/\s*\n\s*/g, " ").slice(0, 600);
      if (!paragraph) {
        paragraph = `${itemName}，清晰的形体比例与材质颜色，表面纹理与细节可见，8k，电影级打光，微距质感。`;
      }
      return { name: itemName, prompt: paragraph };
    })
  );

  const itemsMd =
    itemPromptPairs.length > 0
      ? ["## 物品清单", ...itemPromptPairs.map((p) => `- 物品：${p.name}\n  - 提示词：${p.prompt}`)].join("\n")
      : `## 物品清单\n- 物品：暂无可视化道具\n  - 提示词：暂无`;

  const finalStorylineMd = (storylineText || "").trim()
    ? storylineText.trim()
    : `《${pName}》${rangeLabel} 故事线\n\n【总览】\n时间跨度：单章\n核心主题：围绕冲突推进\n关键转折：本章触发质变\n\n【第一阶段：阶段名称】${rangeLabel}\n- 2-3段概述主要情节（fallback）\n\n【人物关系变化】\n主角：起点 → 新选择\n周边人物：关系变化（fallback）\n\n【重要伏笔】\n1. 伏笔问题（fallback）\n2. 伏笔问题（fallback）\n3. 伏笔问题（fallback）\n\n【节奏与高潮】\n情绪曲线：上升→爆发→余波\n高潮时刻：①本章事件②本章决断\n\n【主题演变】\n第一层：表面冲突 → 具体事件解释\n第二层：行为模式 → 选择决定\n`;

  return { itemsMd, storylineMd: finalStorylineMd };
}

/**
 * 将模型输出的「一行里用 ,.- 镜头2：粘连」或杂乱列表，规整为易读 Markdown。
 * 按「镜头+序号+：」切分；每镜一节 ### 镜头 N，镜间 --- 分隔。
 */
function normalizeStoryboardPromptsMd(md) {
  let s = String(md || "").replace(/\r\n/g, "\n").trim();
  if (!s) return s;

  if (/^##\s*分镜提示词/i.test(s)) {
    s = s.replace(/^##\s*分镜提示词\s*\n*/i, "").trim();
  }
  const title = "## 分镜提示词";

  const re = /镜头\s*(\d+)(?:（[^）]*）)?\s*[：:]/g;
  const hits = [];
  let m;
  while ((m = re.exec(s))) {
    hits.push({ n: m[1], index: m.index, len: m[0].length });
  }

  if (hits.length === 0) {
    return `${title}\n\n${s}`;
  }

  const blocks = [];
  for (let i = 0; i < hits.length; i += 1) {
    const { n, index, len } = hits[i];
    const end = i + 1 < hits.length ? hits[i + 1].index : s.length;
    let body = s.slice(index + len, end).trim();
    body = body.replace(/[,，]\s*-\s*$/g, "").replace(/\n\s*-\s*$/g, "").replace(/[,，.\s\-]+$/g, "").trim();
    body = body.replace(/^[,，\s\-]+/g, "").trim();
    blocks.push(body ? `### 镜头 ${n}\n\n${body}` : `### 镜头 ${n}\n\n（无正文）`);
  }

  let pre = s.slice(0, hits[0].index).trim();
  pre = pre.replace(/^-\s*$/gm, "").replace(/^-\s+/, "").replace(/^[,，.\s\-]+/g, "").trim();
  const preBlock = pre ? `${pre}\n\n` : "";

  return `${title}\n\n${preBlock}${blocks.join("\n\n---\n\n")}`;
}

async function generateStoryboardPrompts({ storyboardMd, storyboardText, analysisText, modelId }) {
  const resolvedStoryboardMd = String(storyboardMd || storyboardText || "").trim();
  const systemPrompt = [
    "你是短剧分镜提示词生成器。",
    "输入包含 storyboardMd（分镜脚本 Markdown 表格）和参考分析文本（人物/场景/物品提示词）。",
    "你的任务不是“重写分镜脚本”，而是：在每一行分镜脚本的基础上，生成一段更连贯、更有动态的画面提示词，让画面能“动起来”。",
    "",
    "你必须逐行读取 storyboardMd 表格，并融合每行的字段信息：",
    "序号、时长、镜头类型、镜头内容、景别、运镜方式、人物动作（或音效/台词字段中的动作信息）。",
    "将这些信息自然组合成一段连贯叙述（画面连续、动作有起承转合），不要只把字段机械拼接。",
    "",
    "硬性内容要求（每个镜头都必须满足）：",
    "1) 提示词正文第一句必须以三段前缀开头并各写具体值：",
    "   【场景】<具体地点·时段> 【人物】<姓名1、姓名2…或无> 【道具/物品】<物品名…或无>",
    "2) 紧接着必须把“景别 + 运镜 + 动作变化”写成动态镜头：",
    "   - 景别：从表格“景别”字段获取并写入（如 全景/中景/近景/特写）。",
    "   - 运镜：从表格“运镜方式”字段获取并写入（如 推进/横移/跟拍/摇镜/拉远）。",
    "   - 动作：以表格“人物动作/镜头内容”的信息为主，写清谁在做什么、动作的起点/过程/结果（例如“抬手—停顿—回头—目光落到某物上”）。",
    "3) 必须补齐可画的画面要素：构图（主体位置/前中后景层次/遮挡）、表情或视线方向、光线与色调（可简短）。",
    "3.1) 【台词必须放在“发生的环节”】若该行表格的「音效/台词」列含对白/台词，或镜头内容中出现明确对话：",
    "   - 你必须把台词插入到对应动作段落中，而不是统一堆在最后一行。",
    "   - 写法：当你描述到“谁开口/谁转头/谁停顿/谁逼近/谁回望”等动作节点时，紧接着在同一行或下一行写：台词（角色名：台词内容）。",
    "   - 多人对话就按时间顺序插入多处：台词（A：...）→动作变化→台词（B：...）。",
    "   - 没有台词则在正文中自然说明“无对白/仅环境声”，不要写专门的末尾汇总行，也不要凭空编台词。",
    "   - 台词出现时必须同步写“说话的动态”：口型、停顿、换气、视线落点、手部小动作或身体重心变化，让观众知道台词发生在什么时候。",
    "4) 禁止抽象套话（如“空间关系建立”“情绪拉满”“氛围感”），必须落到具体动作/构图/光影/物体上。",
    "5) 人物/场景/道具命名优先使用分析文本里的资产名称；不要发明新名字。",
    "",
    "输出格式要求：",
    "- 输出严格 JSON：{ \"promptsMd\": \"...\" }（不要输出解释，不要代码块）。",
    "- promptsMd 排版必须是：第一行 `## 分镜提示词`；每个镜头一节 `### 镜头 N`，空一行，再写该镜头提示词正文。",
    "- 每个镜头提示词正文建议 2-5 行（允许换行以表达动态分层），但不要出现项目符号列表（不要用 - 或 * 开头）。",
    "promptsMd 排版硬性要求（必须遵守，便于人类阅读）：",
    "1）第一行必须是：## 分镜提示词",
    "2）每个镜头单独一节：先写一行「### 镜头 N」（N 为数字），空一行，再写该镜提示词正文；正文可多行，写完再进入下一镜。",
    "3）禁止把所有镜头挤在同一行、用英文逗号或「,.- 镜头2：」这种方式粘连；镜与镜之间用空一行或单独一行「---」分隔。",
    "4）不要使用「- 镜头1：…,- 镜头2：…」这种列表粘连，一律用 ### 标题分段。",
    "5）JSON 里 promptsMd 字符串需含真实换行符（\\n），不要用一行超长字符串。",
    "不要输出解释文本。",
  ].join("\n");

  const userPrompt = `storyboardMd：\n${resolvedStoryboardMd}\n\n参考分析（人物/场景提示词）：\n${analysisText}`;
  const llmText = await callLlm([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], modelId);

  if (!llmText) {
    return "## 分镜提示词\n- 说明：已缺少模型调用，暂未生成逐镜提示词。\n";
  }

  try {
    const parsed = JSON.parse(llmText);
    const raw = parsed.promptsMd || "";
    const normalized = normalizeStoryboardPromptsMd(raw);
    if (String(normalized || "").trim()) return normalized;
  } catch {
    // ignore
  }

  // 容错：模型经常直接吐 Markdown 或在 JSON 外包一层说明；此处兜底为“把全文当 promptsMd”。
  const parsedLoose = parseJsonFromText(llmText, null);
  if (parsedLoose && typeof parsedLoose === "object") {
    const maybe = String(parsedLoose.promptsMd || parsedLoose.prompts_md || "").trim();
    const normalized = normalizeStoryboardPromptsMd(maybe);
    if (normalized) return normalized;
  }

  const fallback = normalizeStoryboardPromptsMd(llmText);
  return (
    String(fallback || "").trim() ||
    "## 分镜提示词\n（说明：模型返回格式异常，未能解析出 promptsMd；请重试生成或在分镜表基础上手动补齐逐镜提示词。）\n"
  );
}

async function auditOutlineAssets({ projectName, outline, modelId }) {
  const directorFull = safeRead(SKILLS.outlineDirector);
  const storyAudit = sliceSkillBetween(
    directorFull,
    "## 🎯 故事线审核标准",
    "## 🎯 大纲审核标准"
  );
  const outputFmt = sliceSkillText(directorFull, "## 📋 审核模板（直接套用）");

  const systemPrompt = [
    "你只审核“故事线是否符合小说逻辑”，不做大纲（JSON）审核。",
    "你必须遵循审核模板的输出要求，不要输出解释文本。",
    storyAudit,
    outputFmt,
  ].join("\n");

  const userPrompt = `小说名：${projectName}\n\n待审核故事线：\n${outline?.storylineMd || ""}\n\n辅助物品清单：\n${outline?.itemsMd || ""}`;

  const llmText = await callLlm([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], modelId);

  if (!llmText) return "✅ 审核通过";
  return llmText.trim();
}

app.get("/api/projects/list", requireAuth, async (req, res) => {
  const projects = await Project.find({ userId: req.userId }).sort({ createdAt: -1 }).lean();
  res.json({ projects });
});

app.post("/api/projects/create", requireAuth, async (req, res) => {
  try {
    const { name, visualStyle } = req.body || {};
    const projectName = safeSlugName(name || "未命名项目");
    const id = newProjectId();
    const settings = {
      id,
      userId: req.userId,
      name: projectName,
      visualStyle: (visualStyle || "").trim() || "写实风，电影感，冷暖对比色调",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    const proj = await Project.create(settings);
    res.json({ ok: true, project: proj });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/save-visual-style", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { visualStyle } = req.body || {};
    const proj = await Project.findOneAndUpdate(
      { id: projectId, userId: req.userId },
      { visualStyle: (visualStyle || "").trim(), updatedAt: new Date().toISOString() },
      { new: true }
    );
    if (!proj) return res.status(404).json({ error: "project not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isSafeProjectId(projectId) {
  return typeof projectId === "string" && /^p_[a-z0-9]+_[a-z0-9]+$/i.test(projectId);
}

app.post("/api/projects/:projectId/delete", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const resDel = await Project.deleteOne({ id: projectId, userId: req.userId });
    if (resDel.deletedCount === 0) return res.status(404).json({ error: "project not found" });
    
    await Chapter.deleteMany({ projectId });
    await Outline.deleteMany({ projectId });
    await Asset.deleteMany({ projectId });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/projects/:projectId/workspace", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const settings = await getProject(req.userId, projectId);
    if (!settings) return res.status(404).json({ error: "project not found" });

    const chapters = await getChapters(req.userId, projectId);
    const result = [];
    for (const c of chapters) {
      const outline = await getOutline(req.userId, projectId, c.id);
      const assets = await getAssets(req.userId, projectId, c.id);
      result.push({
        ...c,
        hasOutline: !!outline && !outline._generationIncomplete,
        hasAssets: !!assets && !assets._generationIncomplete
      });
    }
    res.json({ settings, chapters: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/:chapterId/delete-chapter", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    await Chapter.deleteOne({ projectId, userId: req.userId, id: chapterId });
    await Outline.deleteOne({ projectId, chapterId, userId: req.userId });
    await Asset.deleteOne({ projectId, chapterId, userId: req.userId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/novel/split", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const settings = await getProject(req.userId, projectId);
    if (!settings) return res.status(404).json({ error: "project not found" });

    const { novelText, sourceName, overwrite, append } = req.body || {};

    const rawChapters = splitIntoChapters(novelText);
    if (!rawChapters || rawChapters.length === 0) {
      return res.status(400).json({ error: "未能拆解出章节，请检查输入格式" });
    }

    if (append) {
      // Append mode: dedup by title and insert after existing chapters
      const newChapterObjs = rawChapters.map((c, idx) => ({
        title: c.title || `第${idx + 1}章`,
        content: c.content || "",
      }));
      console.log(`[appendChapters] parsed ${newChapterObjs.length} chapters from text, titles: ${newChapterObjs.map(c => c.title).join(" | ")}`);
      const result = await appendChapters(req.userId, projectId, newChapterObjs);
      console.log(`[appendChapters] added=${result.added} skipped=${result.skipped} total=${result.chapters.length}`);
      return res.json({ ok: true, mode: "append", ...result });
    }

    if (overwrite) {
      // Overwrite mode: wipe everything and re-insert
      await Chapter.deleteMany({ projectId, userId: req.userId });
      await Outline.deleteMany({ projectId, userId: req.userId });
      await Asset.deleteMany({ projectId, userId: req.userId });
      const chapterObjs = rawChapters.map((c, idx) => ({
        id: `c_${idx + 1}`,
        title: c.title || `第${idx + 1}章`,
        content: c.content || "",
      }));
      await replaceAllChapters(req.userId, projectId, chapterObjs);
      return res.json({ ok: true, mode: "overwrite", chapters: chapterObjs });
    }

    // Default mode: only allow if no chapters exist yet, otherwise guide the user
    const existingCount = await Chapter.countDocuments({ projectId, userId: req.userId });
    if (existingCount > 0) {
      return res.status(409).json({
        error: "章节已存在，请使用「追加章节」在已有章节后新增，或使用「重新拆解章节」覆盖全部章节",
        existingCount,
      });
    }

    const chapterObjs = rawChapters.map((c, idx) => ({
      id: `c_${idx + 1}`,
      title: c.title || `第${idx + 1}章`,
      content: c.content || "",
    }));
    await replaceAllChapters(req.userId, projectId, chapterObjs);
    res.json({ ok: true, mode: "replace", chapters: chapterObjs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/projects/:projectId/chapters/:chapterId/outline", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const outline = await getOutline(req.userId, projectId, chapterId);
    if (!outline) return res.status(404).json({ error: "outline not found" });
    res.json(outline);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/:chapterId/outline/save", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const data = req.body || {};
    await saveOutline(req.userId, projectId, chapterId, data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/:chapterId/audit-outline", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const settings = await getProject(req.userId, projectId);
    if (!settings) return res.status(404).json({ error: "project not found" });

    const outline = await getOutline(req.userId, projectId, chapterId);
    if (!outline) return res.status(404).json({ error: "outline not found" });

    const user = await findUserById(req.userId);
    const modelId = resolveUserModel(user);
    const auditText = await auditOutlineAssets({ projectName: settings.name, outline, modelId });
    
    // We update the outline with audit info or store it in a dedicated collection? 
    // Legacy stored it in audit.json. For simplicity, we can add it to Outline model or just partial update.
    await Outline.findOneAndUpdate(
      { projectId, chapterId, userId: req.userId },
      { auditText, auditUpdatedAt: new Date().toISOString() }
    );

    res.json({ ok: true, auditText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/extract-outline", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const settings = await getProject(req.userId, projectId);
    if (!settings) return res.status(404).json({ error: "project not found" });

    const { chapterIds, overwrite, visualStyle } = req.body || {};
    if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
      return res.status(400).json({ error: "chapterIds 不能为空" });
    }

    const taskId = await taskManager.addJob(
      "extractOutline",
      "extractOutlineJob",
      {
        userId: req.userId,
        projectId,
        chapterIds,
        overwrite: !!overwrite,
        visualStyle
      },
      { dedupeKey: `extractOutline:${req.userId}:${projectId}` }
    );
    res.json({ ok: true, taskId, message: "任务已进入队列" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tasks/:taskId", requireAuth, async (req, res) => {
  try {
    const { taskId } = req.params;
    const qName = req.query.queue || "extractOutline";
    const status = await taskManager.getJobStatus(qName, taskId);
    if (!status) return res.status(404).json({ error: "Task not found" });
    if (status.ownerUserId && status.ownerUserId !== req.userId) {
      return res.status(404).json({ error: "Task not found" });
    }
    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/projects/:projectId/chapters/:chapterId/assets", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const assets = await getAssets(req.userId, projectId, chapterId);
    if (!assets) return res.status(404).json({ error: "assets not found" });
    res.json(assets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/:chapterId/assets/save", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const data = req.body || {};
    await saveAssets(req.userId, projectId, chapterId, data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/:chapterId/assets/refine", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const settings = await getProject(req.userId, projectId);
    if (!settings) return res.status(404).json({ error: "project not found" });
    const user = await findUserById(req.userId);
    const modelId = resolveUserModel(user);
    const { moduleType, entries, visualStyle } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "entries required" });
    }

    const promptMap = {
      characters: [
        "你是角色 AI 生图提示词润色助手。",
        "只输出提示词正文（不要解释/不要代码块），不要用 Markdown 列表符号（不要出现以 - 或 * 开头的行）。",
        "必须严格按下方“提示词模板”的字段与顺序输出；字段名必须原样出现；允许换行。",
        "只写画面可见内容（发型/服装/体态/材质/配色/五官细节/可见标记），禁止剧情复述、台词、心理活动、能力设定、世界观讲解。",
        "",
        "【提示词模板】（必须严格照抄结构并填充内容）：",
        "【<风格>】风格，真实感，电影质感，高清摄影，自然光影，细腻肤质，真实人物，请参考提供的图片中的人物外观、面部特征、发型、服装风格、体型等特点，超写实风格，严格参考人物形象，还原人物的美，没有纹身，没有装饰品",
        "角色设计参考图布局要求：",
        "1.主视觉区(上方)：以\u201c正面+侧面+背面\u201d三个核心视角为主体，直观呈现角色的整体身形、服饰搭配和标志性特征，是制作人员对人物\u201c整体造型\u201d的参考基础。",
        "2.补充信息区(左侧)：拆分出\u201c面部特写\u201d和\u201c配色板\u201d(明确毛发、服饰的色值)，补充主视角没覆盖的细节与色彩标准。",
        "3.局部细节区(底部)：用小模块单独展示关键部件的设计(配饰、点缀、关键身份识别元素)，把主视角里的\u201c模糊细节\u201d拆分为精准的制作参考，方便导演确认。",
        "4.全身照比例照(右侧)：使用黄金比例参考物和人物身高形成对比。",
        "衣着：写清上衣/下装/鞋靴的款式与层次、材质、主色+辅色+点缀色",
      ].join("\n"),
      scenes: [
        "你是场景提示词润色（环境）助手。",
        "只输出提示词正文（不要解释/不要代码块）。",
        "150-260字；禁止抽象词，全部改为可视化元素与空间关系。",
        "必须包含：视角；时间与光线(光源/方向/色温/阴影)；空间结构；关键陈设3-8个(材质+颜色+位置)；色调总结。",
        "若输入要求“纯场景”，禁止人物/人形/剪影。",
      ].join("\n"),
      items: [
        "你是道具/物品提示词润色（单体）助手。",
        "只输出提示词正文（不要解释/不要代码块）。",
        "80-180字；只写单体外观：结构部件、材质工艺、颜色标记、新旧磨损、尺度感。",
        "不要出现人物/手部/场景/环境/功能说明/情绪词。",
      ].join("\n"),
      storyboard: [
        "你是分镜脚本润色助手。",
        "根据用户提供的分镜脚本或分镜提示词内容进行润色。",
        "保留原有分镜结构（序号、时长、镜头类型、景别等），精炼描述语言使其更专业。",
        "镜头内容描述应具体可拍，包含：场景名、在场人物姓名、动作/表情/站位、道具/物品；",
        "音效/台词栏保留原始台词或音效描述，可适度补充语气与情绪提示。",
        "不要添加无关解释；只输出润色后的分镜内容。",
      ].join("\n"),
    };
    if (!promptMap[moduleType]) return res.status(400).json({ error: "unsupported moduleType" });

    const refined = [];
    for (const e of entries.slice(0, 30)) {
      const baseText = String(e.content || "").trim();
      const llm = await callLlm(
        [
          { role: "system", content: promptMap[moduleType] },
          {
            role: "user",
            content: `项目:${settings.name}\n风格:${visualStyle || settings.visualStyle || ""}\n标题:${e.title || ""}\n原文本:\n${baseText}`,
          },
        ],
        modelId
      );
      refined.push({
        id: e.id,
        title: e.title || "",
        content: (llm || baseText || "").trim(),
      });
    }

    res.json({ ok: true, refined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/:chapterId/assets/generate-image", requireAuth, async (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const assets = await getAssets(req.userId, projectId, chapterId);
    if (!assets) return res.status(404).json({ error: "assets not found" });

    const { moduleType, entryId, title, prompt, size, resolution, referenceImages } = req.body || {};
    if (!["characters", "scenes", "items"].includes(moduleType)) {
      return res.status(400).json({ error: "moduleType 仅支持 characters/scenes/items" });
    }

    const contentPrompt = String(prompt || "").trim();
    const contentTitle = String(title || "").trim() || "资产";
    const finalPrompt = contentPrompt || contentTitle;
    if (!finalPrompt) return res.status(400).json({ error: "prompt 不能为空" });

    const titleKey = normalizeAssetTitleKey(contentTitle);
    const key = String(entryId || "").trim() || titleKey;

    // ---- Project-level asset library: cross-chapter image reuse ----
    const projectHit = await findProjectAsset(req.userId, projectId, moduleType, contentTitle);
    if (projectHit && Array.isArray(projectHit.images) && projectHit.images.length > 0) {
      const reusableImage = projectHit.images.find((img) => projectAssetImageExistsByUrl(img?.url));
      if (reusableImage) {
        const imageInfo = { ...reusableImage, reused: true, pointsCost: 0 };
        assets.generatedImages = assets.generatedImages && typeof assets.generatedImages === "object" ? assets.generatedImages : {};
        assets.generatedImages[moduleType] =
          assets.generatedImages[moduleType] && typeof assets.generatedImages[moduleType] === "object" ? assets.generatedImages[moduleType] : {};
        const oldByKey = Array.isArray(assets.generatedImages[moduleType][key]) ? assets.generatedImages[moduleType][key] : [];
        const oldByTitle = Array.isArray(assets.generatedImages[moduleType][titleKey]) ? assets.generatedImages[moduleType][titleKey] : [];
        const merged = [imageInfo, ...oldByKey, ...oldByTitle]
          .filter((row, idx, arr) => arr.findIndex((x) => String(x?.url || "") === String(row?.url || "")) === idx)
          .slice(0, 12);
        assets.generatedImages[moduleType][key] = merged;
        assets.generatedImages[moduleType][titleKey] = merged;
        await saveAssets(req.userId, projectId, chapterId, assets);
        return res.json({ ok: true, reused: true, image: imageInfo, images: merged, entryKey: key, titleKey });
      }
    }
    // ---- end reuse check ----

    const user = await findUserById(req.userId);
    const conf = getToapisImageConfig(user);
    const fixedPointsCost = resolveImageModelPointsCost(conf.imageModelId);
    if (fixedPointsCost > 0) {
      await assertUserHasImagePoints(req.userId, fixedPointsCost);
    }
    if (!conf.apiKey) {
      return res.status(500).json({ error: "未配置 TOAPIS_API_KEY，无法执行图片生成" });
    }

    const imageUrls = await normalizeToapisReferenceImages(referenceImages, {
      apiKey: conf.apiKey,
      baseUrl: conf.baseUrl,
    });

    const created = await createToapisImageTask({
      apiKey: conf.apiKey,
      baseUrl: conf.baseUrl,
      model: conf.model,
      prompt: finalPrompt,
      size: String(size || conf.size || "16:9").trim(),
      resolution: String(resolution || conf.resolution || "2K").trim(),
      imageUrls,
    });

    const statusPayload = await pollToapisImageTask({
      apiKey: conf.apiKey,
      baseUrl: conf.baseUrl,
      taskId: created.id,
    });

    const remoteUrl = pickToapisResultUrl(statusPayload);
    if (!remoteUrl) throw new Error("生成成功但未返回图片 URL");

    // Save to project-level dir so the file persists even if a chapter is deleted.
    // If local download fails due to transient network/proxy issues, keep remote URL
    // as a fallback instead of failing the whole generation request.
    let local = null;
    let displayUrl = remoteUrl;
    try {
      local = await downloadRemoteImageToDir({
        imageUrl: remoteUrl,
        absDir: projectAssetDir(req.userId, projectId, moduleType),
      });
      if (local?.publicUrl) displayUrl = local.publicUrl;
    } catch (downloadErr) {
      console.warn("[Image] local download failed, fallback to remote URL:", downloadErr?.message || downloadErr);
    }

    const imageInfo = {
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      url: displayUrl,
      remoteUrl,
      model: conf.model,
      imageModelId: conf.imageModelId,
      imageModelName: resolveImageModelNameById(conf.imageModelId),
      aspectRatio: String(size || conf.size || "16:9").trim(),
      pointsCost: fixedPointsCost,
      prompt: finalPrompt,
      taskId: created.id,
      createdAt: new Date().toISOString(),
    };

    assets.generatedImages = assets.generatedImages && typeof assets.generatedImages === "object" ? assets.generatedImages : {};
    assets.generatedImages[moduleType] =
      assets.generatedImages[moduleType] && typeof assets.generatedImages[moduleType] === "object" ? assets.generatedImages[moduleType] : {};

    const oldByKey = Array.isArray(assets.generatedImages[moduleType][key]) ? assets.generatedImages[moduleType][key] : [];
    const oldByTitle = Array.isArray(assets.generatedImages[moduleType][titleKey]) ? assets.generatedImages[moduleType][titleKey] : [];
    const merged = [imageInfo, ...oldByKey, ...oldByTitle]
      .filter((row, idx, arr) => arr.findIndex((x) => String(x?.url || "") === String(row?.url || "")) === idx)
      .slice(0, 12);
    assets.generatedImages[moduleType][key] = merged;
    assets.generatedImages[moduleType][titleKey] = merged;
    await saveAssets(req.userId, projectId, chapterId, assets);

    try {
    if (fixedPointsCost > 0) {
        await recordUserImageUsageAndDeductPoints({
          userId: req.userId,
          imageModelId: conf.imageModelId,
          pointsCost: fixedPointsCost,
          aspectRatio: imageInfo.aspectRatio,
          projectId,
          chapterId,
          taskId: created.id,
        });
      }
    } catch (chargeErr) {
      // 扣费失败则回滚本次绑定，确保“失败不扣费且不保留成功态结果”
      try {
        const rollback = await getAssets(req.userId, projectId, chapterId);
        if (rollback?.generatedImages?.[moduleType]) {
          const store = rollback.generatedImages[moduleType];
          const listByKey = Array.isArray(store[key]) ? store[key] : [];
          store[key] = listByKey.filter((x) => String(x?.id || "") !== String(imageInfo.id));
          const listByTitle = Array.isArray(store[titleKey]) ? store[titleKey] : [];
          store[titleKey] = listByTitle.filter((x) => String(x?.id || "") !== String(imageInfo.id));
          await saveAssets(req.userId, projectId, chapterId, rollback);
        }
        if (local?.absPath && fs.existsSync(local.absPath)) fs.unlinkSync(local.absPath);
      } catch { }
      throw chargeErr;
    }

    // Write to project-level asset library only after charge path succeeds
    // (prevents unpaid assets from entering reuse library on charge failure).
    try {
      await upsertProjectAsset({
        userId: req.userId,
        projectId,
        moduleType,
        name: contentTitle,
        prompt: finalPrompt,
        image: imageInfo,
      });
    } catch (libErr) {
      console.error("[ProjectAsset] upsert failed (non-fatal):", libErr?.message);
    }

    res.json({
      ok: true,
      reused: false,
      image: imageInfo,
      images: merged,
      entryKey: key,
      titleKey,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "图片生成失败" });
  }
});

// Read-only: list all entries in the project-level asset library
app.get("/api/projects/:projectId/project-assets", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { moduleType } = req.query;
    const filter = { userId: req.userId, projectId };
    if (moduleType && ["characters", "scenes", "items"].includes(moduleType)) {
      filter.moduleType = moduleType;
    }
    const items = await ProjectAsset.find(filter).lean();
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/projects/:projectId/chapters/generate-assets", requireAuth, async (req, res) => {
  try {
    const { projectId } = req.params;
    const settings = await getProject(req.userId, projectId);
    if (!settings) return res.status(404).json({ error: "project not found" });

    const { chapterIds, overwrite } = req.body || {};
    if (!Array.isArray(chapterIds) || chapterIds.length === 0) {
      return res.status(400).json({ error: "chapterIds 不能为空" });
    }

    const taskId = await taskManager.addJob(
      "generateAssets",
      "generateAssetsJob",
      {
        userId: req.userId,
        projectId,
        chapterIds,
        overwrite: !!overwrite
      },
      { dedupeKey: `generateAssets:${req.userId}:${projectId}` }
    );
    
    res.json({ ok: true, taskId, message: "生成任务已进入队列" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


taskManager.registerWorker("extractOutline", async (job) => {
  const { userId, projectId, chapterIds, overwrite, visualStyle } = job.data;
  return requestContext.run({ userId }, async () => {
  const settings = await getProject(userId, projectId);
  if (!settings) throw new Error("project not found");
  const user = await findUserById(userId);
  const modelId = resolveUserModel(user);

  const novelChapters = await getChapters(userId, projectId);
  const chapterMap = new Map((novelChapters || []).map((c) => [c.id, c]));

  const results = [];
  const warnings = [];
  const total = chapterIds.length;
  let currentCount = 0;

  for (const chapterId of chapterIds) {
    currentCount++;
    await job.updateProgress(Math.floor((currentCount / total) * 100));

    const shouldOverwrite = !!overwrite;
    const existingOutline = await getOutline(userId, projectId, chapterId);

    const canResumeOutline =
      existingOutline &&
      existingOutline._generationIncomplete === true &&
      outlineHasValidAnalysisMd(existingOutline);

    if (canResumeOutline && !shouldOverwrite) {
      const chapterText = chapterMap.get(chapterId)?.content || "";
      const projectName = settings.name;
      const vStyle = (visualStyle || settings.visualStyle || "").trim();
      const chapterTitle = chapterMap.get(chapterId)?.title || `第${chapterId}`;
      const { itemsMd, storylineMd } = await generateItemsAndStoryline({
        chapterText,
        analysisText: existingOutline.rawAnalysisMd,
        projectName,
        visualStyle: vStyle,
        chapterRangeLabel: chapterTitle,
        modelId,
      });
      const outlineDone = {
        ...existingOutline,
        itemsMd,
        storylineMd,
        _generationIncomplete: false,
        generatedAt: new Date().toISOString(),
      };
      await saveOutline(userId, projectId, chapterId, outlineDone);
      results.push({ chapterId, skipped: false, resumed: true });
      continue;
    }

    if (!shouldOverwrite && existingOutline && existingOutline._generationIncomplete !== true) {
      results.push({ chapterId, skipped: true });
      continue;
    }

    const chapterText = chapterMap.get(chapterId)?.content || "";
    const projectName = settings.name;
    const vStyle = (visualStyle || settings.visualStyle || "").trim();

    const stage1 = await runStage1Analysis({
      projectName,
      visualStyle: vStyle,
      scriptText: chapterText,
      modelId,
    });
    if (Array.isArray(stage1.analysisJson?.__warnings) && stage1.analysisJson.__warnings.length) {
      warnings.push(...stage1.analysisJson.__warnings.map((w) => ({ ...w, chapterId })));
    }
    const analysisText = stage1.rawAnalysisMd;
    const charactersMd = stage1.charactersMd;
    const scenesMd = stage1.scenesMd;

    const partialOutline = {
      chapterId,
      title: chapterMap.get(chapterId)?.title || "",
      rawAnalysisMd: analysisText,
      analysisJson: stage1.analysisJson,
      charactersMd,
      scenesMd,
      characterCards: stage1.characterCards || [],
      sceneCards: stage1.sceneCards || [],
      itemsMd: "## 物品清单\n- 物品：生成中\n  - 提示词：请稍候\n",
      storylineMd: `《${projectName}》${chapterMap.get(chapterId)?.title || "本章"} 故事线\n\n【生成中】\n`,
      _generationIncomplete: true,
      generatedAt: new Date().toISOString(),
    };
    await saveOutline(userId, projectId, chapterId, partialOutline);

    const chapterTitle = chapterMap.get(chapterId)?.title || `第${chapterId}`;
    const { itemsMd, storylineMd } = await generateItemsAndStoryline({
      chapterText,
      analysisText,
      projectName,
      visualStyle: vStyle,
      chapterRangeLabel: chapterTitle,
      modelId,
    });

    const outline = {
      ...partialOutline,
      itemsMd,
      storylineMd,
      _generationIncomplete: false,
      generatedAt: new Date().toISOString(),
    };
    await saveOutline(userId, projectId, chapterId, outline);
    results.push({ chapterId, skipped: false });
  }

  return { results, warnings };
  }); // end requestContext.run
}, { concurrency: 2 });


taskManager.registerWorker("generateAssets", async (job) => {
  const { userId, projectId, chapterIds, overwrite } = job.data;
  return requestContext.run({ userId }, async () => {
  const settings = await getProject(userId, projectId);
  if (!settings) throw new Error("project not found");
  const user = await findUserById(userId);
  const modelId = resolveUserModel(user);

  const novelChapters = await getChapters(userId, projectId);
  const chapterMap = new Map((novelChapters || []).map((c) => [c.id, c]));

  const results = [];
  const warnings = [];
  const total = chapterIds.length;
  let currentCount = 0;

  for (const chapterId of chapterIds) {
    currentCount++;
    await job.updateProgress(Math.floor((currentCount / total) * 100));

    const shouldOverwrite = !!overwrite;
    const existingAssets = await getAssets(userId, projectId, chapterId);

    const canResumeAssets =
      existingAssets &&
      existingAssets._generationIncomplete === true &&
      String(existingAssets.storyboardMd || "").trim().length > 0;

    if (canResumeAssets && !shouldOverwrite) {
      let outlineResume = await getOutline(userId, projectId, chapterId);
      if (!outlineHasValidAnalysisMd(outlineResume)) {
        const chTitle = chapterMap.get(chapterId)?.title || chapterId;
        warnings.push({
          chapterId,
          code: "MISSING_OUTLINE",
          message: `章节「${chTitle}」大纲缺失，无法补全分镜提示词。请重新提取大纲后，再点一次生成资产。`,
        });
        results.push({ chapterId, skipped: true, reason: "missing_outline" });
        continue;
      }
      const chTitle = chapterMap.get(chapterId)?.title || `第${chapterId}`;
      const promptsMd = await generateStoryboardPrompts({
        projectName: settings.name,
        visualStyle: (settings.visualStyle || "").trim(),
        chapterRangeLabel: chTitle,
        analysisText: outlineResume.rawAnalysisMd,
        storyboardText: existingAssets.storyboardMd,
        modelId,
      });

      const assetsDone = {
        ...existingAssets,
        charactersMd: outlineResume.charactersMd || existingAssets.charactersMd || "",
        scenesMd: outlineResume.scenesMd || existingAssets.scenesMd || "",
        itemsMd: outlineResume.itemsMd || existingAssets.itemsMd || "",
        characterCards: Array.isArray(outlineResume.characterCards) ? outlineResume.characterCards : (existingAssets.characterCards || []),
        sceneCards: Array.isArray(outlineResume.sceneCards) ? outlineResume.sceneCards : (existingAssets.sceneCards || []),
        chapterText: chapterMap.get(chapterId)?.content || existingAssets.chapterText || "",
        storyboardPromptsMd: promptsMd || "",
        _generationIncomplete: false,
        generatedAt: new Date().toISOString(),
      };
      await saveAssets(userId, projectId, chapterId, assetsDone);
      results.push({ chapterId, skipped: false, resumed: true });
      continue;
    }

    if (!shouldOverwrite && existingAssets && existingAssets._generationIncomplete !== true) {
      results.push({ chapterId, skipped: true });
      continue;
    }

    const outline = await getOutline(userId, projectId, chapterId);
    if (!outlineHasValidAnalysisMd(outline)) {
      const chTitle = chapterMap.get(chapterId)?.title || chapterId;
      warnings.push({
        chapterId,
        code: "MISSING_OUTLINE",
        message: `章节「${chTitle}」尚未提取有效大纲，请先回到【提大纲】步骤处理本章。`,
      });
      results.push({ chapterId, skipped: true, reason: "missing_outline" });
      continue;
    }

    const chapterText = chapterMap.get(chapterId)?.content || "";
    const chTitle = chapterMap.get(chapterId)?.title || `第${chapterId}`;

    const stage2 = await runStage2Assets({
      projectName: settings.name,
      chapterText,
      analysisText: outline.rawAnalysisMd,
      itemsMd: outline.itemsMd,
      storylineMd: outline.storylineMd,
      modelId,
    });
    if (Array.isArray(stage2.storyboardJson?.__warnings) && stage2.storyboardJson.__warnings.length) {
      warnings.push(...stage2.storyboardJson.__warnings.map((w) => ({ ...w, chapterId })));
    }
    const storyboardMd = stage2.storyboardMd;

    const partialAssets = {
      chapterId,
      title: chTitle,
      charactersMd: outline.charactersMd || "",
      scenesMd: outline.scenesMd || "",
      itemsMd: outline.itemsMd || "",
      characterCards: Array.isArray(outline.characterCards) ? outline.characterCards : [],
      sceneCards: Array.isArray(outline.sceneCards) ? outline.sceneCards : [],
      chapterText,
      storyboardJson: stage2.storyboardJson,
      storyboardMd,
      storyboardPromptsMd: "## 镜号级画面提示词\n\n【生成中，请耐心等待。您可以暂时离开此页面。】\n",
      _generationIncomplete: true,
      generatedAt: new Date().toISOString(),
    };
    await saveAssets(userId, projectId, chapterId, partialAssets);

    const promptsMd = await generateStoryboardPrompts({
      projectName: settings.name,
      visualStyle: (settings.visualStyle || "").trim(),
      chapterRangeLabel: chTitle,
      storyboardText: storyboardMd,
      analysisText: outline.rawAnalysisMd,
      modelId,
    });

    const assets = {
      ...partialAssets,
      storyboardPromptsMd: promptsMd || "",
      _generationIncomplete: false,
      generatedAt: new Date().toISOString(),
    };
    await saveAssets(userId, projectId, chapterId, assets);
    results.push({ chapterId, skipped: false });
  }

  return { results, warnings };
  }); // end requestContext.run
}, { concurrency: 2 });


// -----------------------------
// MongoDB Automatic Backup
// -----------------------------
const BACKUP_DIR = path.join(OUTPUT_ROOT, "backups");
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_HOURS || 6) * 3600_000;
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS || 30);

async function runMongoBackup() {
  try {
    ensureDir(BACKUP_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(BACKUP_DIR, `backup_${ts}`);
    ensureDir(backupPath);

    const collections = [
      { name: "users", model: User },
      { name: "orders", model: Order },
      { name: "projects", model: Project },
      { name: "chapters", model: Chapter },
      { name: "outlines", model: Outline },
      { name: "assets", model: Asset },
      { name: "custom_models", model: CustomModels },
    ];

    let totalDocs = 0;
    for (const { name, model } of collections) {
      const docs = await model.find({}).lean();
      fs.writeFileSync(
        path.join(backupPath, `${name}.json`),
        JSON.stringify(docs, null, 2),
        "utf-8"
      );
      totalDocs += docs.length;
    }

    const manifest = {
      createdAt: new Date().toISOString(),
      collections: collections.map(c => c.name),
      totalDocuments: totalDocs,
    };
    fs.writeFileSync(
      path.join(backupPath, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8"
    );

    console.log(`[Backup] Completed: ${backupPath} (${totalDocs} documents)`);
    cleanOldBackups();
  } catch (err) {
    console.error("[Backup] Failed:", err?.message || err);
  }
}

function cleanOldBackups() {
  try {
    const dirs = fs.readdirSync(BACKUP_DIR)
      .filter(d => d.startsWith("backup_") && fs.statSync(path.join(BACKUP_DIR, d)).isDirectory())
      .sort()
      .reverse();
    if (dirs.length > MAX_BACKUPS) {
      for (const old of dirs.slice(MAX_BACKUPS)) {
        const fullPath = path.join(BACKUP_DIR, old);
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`[Backup] Removed old backup: ${old}`);
      }
    }
  } catch (err) {
    console.error("[Backup] Cleanup error:", err?.message || err);
  }
}

setInterval(runMongoBackup, BACKUP_INTERVAL_MS);

// Backup on graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[Shutdown] SIGTERM received, running final backup...");
  await runMongoBackup();
  process.exit(0);
});
process.on("SIGINT", async () => {
  console.log("[Shutdown] SIGINT received, running final backup...");
  await runMongoBackup();
  process.exit(0);
});

if (process.env.DISABLE_HTTP === "1") {
  console.log("[HTTP] DISABLE_HTTP=1, skip app.listen");
} else {
  app.listen(port, () => {
    console.log(`Xflow server running at http://localhost:${port}`);
  });
}
