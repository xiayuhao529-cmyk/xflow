import "../type";
import axios from "axios";
import jwt from "jsonwebtoken";
import u from "@/utils";
import { pollTask } from "@/utils/ai/utils";

function generateJwtToken(ak: string, sk: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ak,
    exp: now + 1800,
    nbf: now - 5,
  };
  return jwt.sign(payload, sk, {
    algorithm: "HS256",
    header: { alg: "HS256", typ: "JWT" },
  });
}

function getApiToken(apiKey: string): string {
  const trimmedKey = apiKey.replace(/^Bearer\s+/i, "").trim();

  if (trimmedKey.includes("|")) {
    const parts = trimmedKey.split("|");
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      throw new Error("API Key格式错误，请使用 ak|sk 格式");
    }
    return generateJwtToken(parts[0].trim(), parts[1].trim());
  }

  return trimmedKey;
}

async function processImages(imageBase64: string[]): Promise<Array<{ image: string }>> {
  let images = imageBase64.filter((img) => img?.trim());
  if (images.length === 0) return [];

  // 压缩所有图片到10MB以内
  images = await Promise.all(images.map((img) => u.imageTools.compressImage(img, "10mb")));

  // 参考主体数量和参考图片数量之和不得超过10
  if (images.length > 10) {
    const mergeImageList = images.splice(9);
    const mergedImage = await u.imageTools.mergeImages(mergeImageList, "10mb");
    images.push(mergedImage);
  }

  return images.map((img) => ({
    image: img.replace(/^data:image\/[a-z]+;base64,/i, ""),
  }));
}

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!input.prompt) throw new Error("缺少提示词，prompt为必填项");

  const authorization = `Bearer ${getApiToken(config.apiKey)}`;
  const baseURL = (config.baseURL ?? "https://api-beijing.klingai.com/v1/images/omni-image").replace(/\/+$/, "");
  const imageList = await processImages(input.imageBase64);

  const body: Record<string, any> = {
    model_name: config.model || "kling-image-o1",
    prompt: input.prompt,
    n: 1,
    ...(input.size !== "4K" && { resolution: input.size.toLowerCase() }),
    ...(imageList.length > 0 && { image_list: imageList }),
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: authorization,
  };

  try {
    const { data: createData } = await axios.post(baseURL, body, { headers });

    if (createData.code !== 0) {
      throw new Error(createData.message || "创建任务失败");
    }

    const taskId = createData.data?.task_id;
    if (!taskId) throw new Error("未获取到任务ID");

    const queryUrl = `${baseURL}/${taskId}`;
    return await pollTask(async () => {
      const { data: queryData } = await axios.get(queryUrl, { headers });

      if (queryData.code !== 0) {
        return { completed: false, error: queryData.message || "查询任务失败" };
      }

      const { task_status, task_status_msg, task_result } = queryData.data || {};

      if (task_status === "failed") {
        return { completed: false, error: task_status_msg || "图片生成失败" };
      }

      if (task_status === "succeed") {
        return { completed: true, url: task_result?.images?.[0]?.url };
      }

      return { completed: false };
    });
  } catch (error) {
    throw new Error(u.error(error).message || "可灵图片生成失败");
  }
}
