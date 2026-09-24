import "../type";
import axios from "axios";
import { pollTask, validateVideoConfig } from "@/utils/ai/utils";
import modelList from "../modelList";

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!input.prompt && (!input.imageBase64 || input.imageBase64.length === 0)) {
    throw new Error("至少需要提供prompt或图片");
  }

  const defaultBaseUrl = ["https://api.vidu.cn/ent/v2/text2video", "https://api.vidu.cn/ent/v2/img2video", "https://api.vidu.cn/ent/v2/tasks"].join(
    "|",
  );

  const [text2videoUrl, image2videoUrl, queryUrl] = (config.baseURL || defaultBaseUrl).split("|");

  const authorization = `Token ${config.apiKey}`;
  const hasImages = input.imageBase64 && input.imageBase64.length > 0;

  // 根据是否有图片，查找匹配的模型配置
  // const customOwned = modelList.find((m) => {
  //   if (m.manufacturer !== "vidu") return false;
  //   if (m.model !== config.model) return false;
  //   if (hasImages) {
  //     return m.type.some((t) => t !== "text");
  //   } else {
  //     return m.type.includes("text");
  //   }
  // });

  // if (!customOwned) {
  //   throw new Error(`未找到匹配的模型配置: ${config.model}`);
  // }

  // 使用统一校验函数
  // const { owned, images } = validateVideoConfig(input, config, customOwned);

  // 判断生成类型
  const genType: "text" | "image" = input.imageBase64 && input.imageBase64.length === 0 ? "text" : "image";

  // // 校验宽高比（仅文生视频需要）
  // if (genType === "text" && owned.aspectRatio.length > 0 && !owned.aspectRatio.includes(input.aspectRatio as `${number}:${number}`)) {
  //   throw new Error(`模型 ${owned.model} 不支持宽高比 ${input.aspectRatio}，支持的宽高比：${owned.aspectRatio.join("、")}`);
  // }

  // 创建任务
  let taskId: string;

  if (genType === "text") {
    // 文生视频
    const requestBody: Record<string, unknown> = {
      model: config.model,
      prompt: input.prompt,
      duration: input.duration,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
    };
    if (input.audio && input.audio !== undefined) {
      requestBody.audio = input.audio;
    }

    const response = await axios.post(text2videoUrl, requestBody, {
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
    });
      console.log("%c Line:65 🍢 response", "background:#3f7cff", response);
      

    taskId = response.data.task_id;
  } else {
    // 图生视频
    const requestBody: Record<string, unknown> = {
      model: config.model,
      images: input.imageBase64,
      duration: input.duration,
      resolution: input.resolution,
    };
    if (input.prompt) {
      requestBody.prompt = input.prompt;
    }
    if (input.audio && input.audio !== undefined) {
      requestBody.audio = input.audio;
    }

    const response = await axios.post(image2videoUrl, requestBody, {
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
    });
      console.log("%c Line:90 🍷 response", "background:#2eafb0", response.data);

    taskId = response.data.task_id;
  }

  // 轮询任务状态
  return await pollTask(async () => {
    const response = await axios.get(queryUrl, {
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      params: {
        task_ids: [taskId],
      },
    });
    console.log("%c Line:113 🧀 response.data", "background:#33a5ff", response.data);

    const tasks = response.data.tasks;
    if (!tasks || tasks.length === 0) {
      return { completed: false, error: "任务不存在" };
    }

    const task = tasks[0];

    switch (task.state) {
      case "success": {
        const creation = task.creations?.[0];
        return {
          completed: true,
          url: creation?.url,
        };
      }
      case "failed":
        return { completed: false, error: "任务生成失败" };
      case "created":
      case "queueing":
      case "processing":
        return { completed: false };
      default:
        return { completed: false, error: `未知状态: ${task.state}` };
    }
  });
};
