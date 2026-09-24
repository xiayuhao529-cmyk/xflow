import "../type";
import axios from "axios";
import { pollTask, validateVideoConfig } from "@/utils/ai/utils";

// 根据分辨率档位和宽高比计算具体尺寸
const getSizeFromConfig = (resolution: string, aspectRatio: string): string => {
  const sizeMap: Record<string, Record<string, string>> = {
    "480p": {
      "16:9": "832*480",
      "9:16": "480*832",
      "1:1": "624*624",
    },
    "720p": {
      "16:9": "1280*720",
      "9:16": "720*1280",
      "1:1": "960*960",
      "4:3": "1088*832",
      "3:4": "832*1088",
    },
    "1080p": {
      "16:9": "1920*1080",
      "9:16": "1080*1920",
      "1:1": "1440*1440",
      "4:3": "1632*1248",
      "3:4": "1248*1632",
    },
  };

  const resolutionKey = resolution.toLowerCase();
  const size = sizeMap[resolutionKey]?.[aspectRatio];

  if (!size) {
    throw new Error(`不支持的分辨率(${resolution})和宽高比(${aspectRatio})组合`);
  }

  return size;
};

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.apiKey) throw new Error("缺少API Key");

  // const { owned, images, hasStartEndType, hasTextType } = validateVideoConfig(input, config);
  const hasStartEndType = input.mode === "startEnd";
  const hasTextType = input.mode === "text";
  const images = input.imageBase64 || [];
  const defaultBaseUrl = [
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis",
    "https://dashscope.aliyuncs.com/api/v1/tasks/{taskId}",
  ].join("|");

  const [i2vUrl, kf2vUrl, queryUrl] = (config.baseURL || defaultBaseUrl).split("|");

  // const types = owned.type;
  const authorization = `Bearer ${config.apiKey}`;

  // 确定端点和构建请求体
  let submitUrl: string;
  let body: Record<string, any>;

  if (hasTextType && images.length === 0) {
    // 文本生视频
    submitUrl = i2vUrl;
    body = {
      model: config.model,
      input: {
        prompt: input.prompt,
      },
      parameters: {
        size: getSizeFromConfig(input.resolution, input.aspectRatio),
        duration: input.duration,
      },
    };
  } else if (input.mode  == 'single' && images.length === 1) {
    // 图生视频
    submitUrl = i2vUrl;
    body = {
      model: config.model,
      input: {
        prompt: input.prompt,
        img_url: images[0],
      },
      parameters: {
        resolution: input.resolution.toUpperCase(),
        duration: input.duration,
      },
    };
    // audio参数仅部分模型支持
    if (input.audio && input.audio !== undefined) {
      body.parameters.audio = input.audio;
    }
  } else if (hasStartEndType) {
    // 首尾帧
    submitUrl = kf2vUrl;
    const inputObj: Record<string, any> = {
      prompt: input.prompt,
      first_frame_url: images[0],
    };
    // 尾帧处理
    if (hasStartEndType && images.length >= 2) {
      inputObj.last_frame_url = images[1];
    }
    body = {
      model: config.model,
      input: inputObj,
      parameters: {
        resolution: input.resolution.toUpperCase(),
        duration: input.duration,
      },
    };
  } else {
    throw new Error(`不支持的视频生成类型: ${hasStartEndType ? "startEnd" : hasTextType ? "text" : "single"}`);
  }

  // 提交任务
  const submitResponse = await axios.post(submitUrl, body, {
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "X-DashScope-Async": "enable",
    },
  });

  const submitData = submitResponse.data;
  if (submitData.code) {
    throw new Error(`任务提交失败: [${submitData.code}] ${submitData.message}`);
  }

  const taskId = submitData.output?.task_id;
  if (!taskId) {
    throw new Error("任务提交失败: 未返回task_id");
  }

  // 轮询任务状态
  return await pollTask(async () => {
    const response = await axios.get(queryUrl.replace("{taskId}", taskId), {
      headers: { Authorization: authorization },
    });

    const data = response.data;

    // 顶层错误
    if (data.code) {
      return { completed: false, error: `[${data.code}] ${data.message}` };
    }

    const taskStatus = data.output?.task_status;

    switch (taskStatus) {
      case "SUCCEEDED":
        return { completed: true, url: data.output?.video_url };
      case "FAILED":
        return {
          completed: false,
          error: `任务失败: [${data.output?.code || "UNKNOWN"}] ${data.output?.message || "未知错误"}`,
        };
      case "CANCELED":
        return { completed: false, error: "任务已取消" };
      case "UNKNOWN":
        return { completed: false, error: "任务不存在或状态未知" };
      case "PENDING":
      case "RUNNING":
        return { completed: false };
      default:
        return { completed: false, error: `未知状态: ${taskStatus}` };
    }
  });
};
