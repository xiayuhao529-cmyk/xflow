import "../type";
import axios from "axios";
import { pollTask, validateVideoConfig } from "@/utils/ai/utils";

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!config.baseURL) throw new Error("缺少baseURL配置");

  // const { images } = validateVideoConfig(input, config);

  // 解析URL配置：图生视频|文生视频|查询地址
  const defaultBaseUrl =
    "https://api-beijing.klingai.com/v1/videos/image2video|https://api-beijing.klingai.com/v1/videos/text2video|https://api-beijing.klingai.com/v1/videos/text2video/{taskId}";
  const [image2videoUrl, text2videoUrl, queryUrl] = (config.baseURL || defaultBaseUrl).split("|");

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };

  // 解析模型名称和模式，例如 "kling-v2-6(PRO)" => modelName: "kling-v2-6", mode: "pro"
  const modelMatch = config.model!.match(/^(.+)\((STD|PRO)\)$/i);
  const modelName = modelMatch ? modelMatch[1] : config.model;
  const mode = modelMatch ? (modelMatch[2].toLowerCase() as "std" | "pro") : "std";

  // 判断是图生视频还是文生视频
  const hasImage = input.imageBase64 ? input.imageBase64.length > 0 : false;
  const createUrl = hasImage ? image2videoUrl : text2videoUrl;

  // 去除图片的内容类型前缀（kling要求纯base64）
  const stripDataUrl = (str: string) => str.replace(/^data:image\/[^;]+;base64,/, "");

  // 构建请求体
  const body: Record<string, unknown> = {
    model_name: modelName,
    mode,
    duration: String(input.duration),
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
  };

  if (hasImage) {
    // 图生视频：首帧和尾帧
    body.image = stripDataUrl(input.imageBase64![0]);
    if (input.imageBase64!.length > 1) {
      body.image_tail = stripDataUrl(input.imageBase64![1]);
    }
  }

  // 创建任务
  const createResponse = await axios.post(createUrl, body, { headers });
  const createData = createResponse.data;
  if (createData.code !== 0) {
    throw new Error(`创建任务失败: ${createData.message || "未知错误"}`);
  }

  const taskId = createData.data?.task_id;
  if (!taskId) {
    throw new Error("创建任务失败: 未返回任务ID");
  }

  // 轮询任务状态
  return await pollTask(async () => {
    const queryResponse = await axios.get(`${queryUrl.replace("{taskId}", taskId)}`, { headers });
    const queryData = queryResponse.data;
    if (queryData.code !== 0) {
      return { completed: false, error: `查询失败: ${queryData.message || "未知错误"}` };
    }

    const task = queryData.data;
    const taskStatus = task?.task_status;

    switch (taskStatus) {
      case "succeed": {
        const videoUrl = task?.task_result?.videos?.[0]?.url;
        if (!videoUrl) {
          return { completed: false, error: "任务成功但未返回视频URL" };
        }
        return { completed: true, url: videoUrl };
      }
      case "failed":
        return { completed: false, error: `任务失败: ${task?.task_status_msg || "未知原因"}` };
      case "submitted":
      case "processing":
        return { completed: false };
      default:
        return { completed: false, error: `未知状态: ${taskStatus}` };
    }
  });
};
