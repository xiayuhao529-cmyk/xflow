import "../type";
import axios from "axios";
import { pollTask } from "@/utils/ai/utils";
import modelList from "../modelList";

// 上传图片到 apimart 图床
async function uploadImageToApimart(base64Image: string): Promise<string> {
  if (base64Image.startsWith("http")) {
    return base64Image;
  }

  const presignRes = await axios.post(
    "https://apimart.ai/api/upload/presign",
    { contentType: "image/jpeg", fileExtension: "jpeg", permanent: false },
    { headers: { "Content-Type": "application/json" } },
  );

  if (!presignRes.data.success || !presignRes.data.presignedUrl || !presignRes.data.cdnUrl) {
    throw new Error(`获取预签名 URL 失败: ${JSON.stringify(presignRes.data)}`);
  }

  const { presignedUrl, cdnUrl } = presignRes.data;

  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");

  await axios.put(presignedUrl, buffer, {
    headers: { "Content-Type": "image/jpeg" },
  });

  return cdnUrl;
}

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.model) throw new Error("缺少 Model 名称");
  if (!config.apiKey) throw new Error("缺少 API Key");

  const owned = modelList.find((m) => m.model === config.model);
  if (!owned) throw new Error(`未找到模型: ${config.model}`);

  // 默认 baseURL 配置
  const defaultBaseUrl = "https://api.apimart.ai/v1/videos/generations|https://api.apimart.ai/v1/tasks/{taskId}";
  const [generateUrl, queryUrl] = (config.baseURL || defaultBaseUrl).split("|");

  const authorization = `Bearer ${config.apiKey}`;

  // 上传图片到图床
  let imageUrls: string[] = [];
  if (input.imageBase64 && input.imageBase64.length > 0) {
    for (const base64Image of input.imageBase64) {
      const imageUrl = await uploadImageToApimart(base64Image);
      imageUrls.push(imageUrl);
    }
  }

  // 构建请求体
  const requestBody: Record<string, unknown> = {
    model: config.model,
    prompt: input.prompt,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
  };

  if (imageUrls.length > 0) {
    requestBody.image_urls = imageUrls;
  }

  // 创建任务
  const createRes = await axios.post(generateUrl, requestBody, {
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
  });

  if (createRes.data.code !== 200 || !createRes.data.data?.[0]?.task_id) {
    throw new Error(`创建任务失败: ${JSON.stringify(createRes.data)}`);
  }

  const taskId = createRes.data.data[0].task_id;
  const actualQueryUrl = queryUrl.replace("{taskId}", taskId);

  // 轮询任务状态
  return await pollTask(async () => {
    const queryRes = await axios.get(actualQueryUrl, {
      headers: { Authorization: authorization },
    });

    const { code, data } = queryRes.data;

    if (code !== 200 || !data) {
      return { completed: false, error: `查询失败: ${JSON.stringify(queryRes.data)}` };
    }

    const { status, result, error } = data;

    switch (status) {
      case "completed":
        const videoUrl = result?.videos?.[0]?.url?.[0];
        if (!videoUrl) {
          return { completed: false, error: "未获取到视频 URL" };
        }
        return { completed: true, url: videoUrl };
      case "failed":
        return { completed: false, error: error?.message || "任务失败" };
      case "cancelled":
        return { completed: false, error: "任务已取消" };
      case "pending":
      case "processing":
        return { completed: false };
      default:
        return { completed: false, error: `未知状态: ${status}` };
    }
  });
};
