const mongoose = require("mongoose");

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[MongoDB] MONGODB_URI not found in .env. Database operations will fail.");
    return;
  }
  try {
    await mongoose.connect(uri);
    console.log("[MongoDB] Connected successfully.");
  } catch (err) {
    console.error("[MongoDB] Connection error:", err.message);
    process.exit(1);
  }
};

// --- User Schema ---
const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  phone: { type: String, required: true, unique: true },
  password: { type: String },
  selectedModelId: String,
  selectedImageModelId: String,
  selectedImageAspectRatio: String,
  pointsBalance: { type: Number, default: 0 },
  pointsSpent: { type: Number, default: 0 },
  tokenUsage: {
    prompt: { type: Number, default: 0 },
    completion: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  billingLogs: { type: Array, default: [] },
  billingUpdatedAt: String,
  accountDisabled: { type: Boolean, default: false },
  passwordUpdatedAt: String,
  lastUsage: Object,
  createdAt: { type: String },
  updatedAt: { type: String },
  customTextModel: {
    enabled:   { type: Boolean, default: false },
    provider:  { type: String,  default: "oioiapi" },
    baseUrl:   { type: String,  default: "https://oioiapi.site/v1" },
    modelName: { type: String,  default: "" },
    // Stores encrypted text when CUSTOM_KEY_ENCRYPTION_SECRET is configured.
    apiKey:    { type: String,  default: "" },
  },
  // Legacy support field (will be migrated automatically on first read)
  doc: { type: Object }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);

// --- Payment/Order Schema ---
const orderSchema = new mongoose.Schema({
  outTradeNo: { type: String, required: true, unique: true },
  userId: String,
  userPhone: String,
  planId: String,
  subject: String,
  totalAmount: String,
  points: Number,
  channel: String,
  status: String,
  tradeStatus: String,
  tradeNo: String,
  buyerLogonId: String,
  gmtPayment: String,
  receiptAmount: String,
  buyerPayAmount: String,
  creditedAt: String,
  creditError: String,
  notifiedAt: String,
  settledAt: String,
  settleFrom: String,
  notifyIp: String,
  notifySnapshot: Object,
  querySnapshot: Object
}, { timestamps: true });

const Order = mongoose.model("Order", orderSchema);

// --- Project Schema ---
const projectSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  name: String,
  visualStyle: String,
  createdAt: String,
  updatedAt: String,
}, { timestamps: true });

const Project = mongoose.model("Project", projectSchema);

// --- Chapter Schema ---
const chapterSchema = new mongoose.Schema({
  projectId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  id: { type: String, required: true },
  title: String,
  order: { type: Number, default: 0 },
  content: { type: String, default: "" }
}, { timestamps: true });

chapterSchema.index({ userId: 1, projectId: 1, id: 1 }, { unique: true });
const Chapter = mongoose.model("Chapter", chapterSchema);

// --- Outline Schema ---
const outlineSchema = new mongoose.Schema({
  projectId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  chapterId: { type: String, required: true, index: true },
  title: String,
  rawAnalysisMd: String,
  analysisJson: Object,
  charactersMd: String,
  scenesMd: String,
  characterCards: Array,
  sceneCards: Array,
  itemsMd: String,
  storylineMd: String,
  _generationIncomplete: Boolean,
  generatedAt: String
}, { timestamps: true });

outlineSchema.index({ userId: 1, projectId: 1, chapterId: 1 }, { unique: true });
const Outline = mongoose.model("Outline", outlineSchema);

// --- Asset Schema ---
const assetSchema = new mongoose.Schema({
  projectId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  chapterId: { type: String, required: true, index: true },
  title: String,
  charactersMd: String,
  scenesMd: String,
  itemsMd: String,
  characterCards: Array,
  sceneCards: Array,
  itemCards: Array,
  chapterText: String,
  storyboardJson: Object,
  storyboardMd: String,
  storyboardPromptsMd: String,
  generatedImages: Object,
  _generationIncomplete: Boolean,
  generatedAt: String
}, { timestamps: true });

assetSchema.index({ userId: 1, projectId: 1, chapterId: 1 }, { unique: true });
const Asset = mongoose.model("Asset", assetSchema);

// --- Custom Models Schema ---
const customModelsSchema = new mongoose.Schema({
  key: { type: String, default: "singleton", unique: true },
  textModels: Array,
  imageModels: Array,
  // OpenAI 兼容 oioiapi 上游基址（含 /v1）。空则走环境变量 OIOIAPI_BASE_URL 或默认 https://oioiapi.site/v1
  oioiapiBaseUrl: { type: String, default: "" },
}, { timestamps: true });

const CustomModels = mongoose.model("CustomModel", customModelsSchema);

// --- ProjectAsset Schema (project-level asset image library for cross-chapter reuse) ---
const projectAssetSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  moduleType: { type: String, enum: ["characters", "scenes", "items"], required: true },
  name: { type: String, required: true },
  normalizedName: { type: String, required: true },
  prompt: String,
  images: { type: Array, default: [] },
}, { timestamps: true });

projectAssetSchema.index(
  { userId: 1, projectId: 1, moduleType: 1, normalizedName: 1 },
  { unique: true }
);

const ProjectAsset = mongoose.model("ProjectAsset", projectAssetSchema);

module.exports = {
  connectDB,
  User,
  Order,
  Project,
  Chapter,
  Outline,
  Asset,
  CustomModels,
  ProjectAsset,
};
