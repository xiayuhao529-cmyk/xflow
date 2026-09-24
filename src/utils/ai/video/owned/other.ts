import "../type";
import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import u from "@/utils";

import { pollTask, validateVideoConfig } from "@/utils/ai/utils";
function template(replaceObj: Record<string, any>, url: string) {
  return url.replace(/\{(\w+)\}/g, (match, varName) => {
    return replaceObj.hasOwnProperty(varName) ? replaceObj[varName] : match;
  });
}
export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!config.baseURL) throw new Error("缺少baseURL");
  // const { owned, images, hasTextType } = validateVideoConfig(input, config);

  const authorization = `Bearer ${config.apiKey}`;
  const urls = config.baseURL.split("|");
  const isThreeUrlMode = urls.length === 3;
  console.log("%c Line:24 🌭 isThreeUrlMode", "background:#ed9ec7", isThreeUrlMode);

  let requestUrl: string, queryUrl: string, downLoadUrl: string | undefined;

  if (isThreeUrlMode) {
    [requestUrl, queryUrl, downLoadUrl] = urls;
  } else {
    [requestUrl, queryUrl] = urls;
  }

  // 根据 aspectRatio 设置 size
  const sizeMap: Record<string, string> = {
    "16:9": "1280x720",
    "9:16": "720x1280",
  };
  let resData;
  let taskId = "";
  if (isThreeUrlMode) {
    // 三个地址：使用 FormData 方式
    const formData = new FormData();
    formData.append("model", config.model);
    formData.append("prompt", input.prompt);
    formData.append("seconds", String(input.duration));

    const size = sizeMap[input.aspectRatio] || "1280x720";
    formData.append("size", size);

    if (input.imageBase64 && input.imageBase64.length) {
      const base64Data = input.imageBase64[0]!.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");

      // 解析尺寸
      const [width, height] = size.split("x").map(Number);

      // 使用 sharp 调整图片尺寸
      const resizedBuffer = await sharp(buffer).resize(width, height, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer();

      formData.append("input_reference", resizedBuffer, { filename: "image.jpg", contentType: "image/jpeg" });
    }

    const response = await axios.post(requestUrl, formData, {
      headers: { Authorization: authorization, ...formData.getHeaders() },
    });

    taskId = response.data?.task_id || response.data?.id;
    resData = response.data;
  } else {
    // 两个地址：使用 JSON 方式

    const requestBody: any = {
      model: config.model,
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio || "16:9",
      size: "720p",
    };

    if (input.imageBase64 && input.imageBase64.length) {
      requestBody.images = input.imageBase64;
    }

    const response = await axios.post(requestUrl, JSON.stringify(requestBody), {
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
    });
    taskId = response.data.id;
    resData = response.data;
  }
  console.log("%c Line:87 🥒 taskId", "background:#f5ce50", taskId);

  if (!taskId) throw new Error(`任务提交失败: ${resData ? JSON.stringify(resData) : "未知错误"}`);

  return await pollTask(async () => {
    // 构建查询URL，两个地址模式时使用URL参数
    const finalQueryUrl = isThreeUrlMode ? template({ id: taskId }, queryUrl) : `${queryUrl}?id=${taskId}`;

    const { data: queryData } = await axios.get(finalQueryUrl, {
      headers: { Authorization: authorization },
    });
    console.log("%c Line:100 🥑 queryData", "background:#42b983", queryData);

    if (queryData.status === "completed") {
      // 下载视频，带重试机制
      let videoRes;
      let retries = 3;
      let lastError;

      for (let i = 0; i < retries; i++) {
        try {
          // 构建下载URL
          const finalDownloadUrl = isThreeUrlMode && downLoadUrl ? template({ id: taskId }, downLoadUrl) : queryData.video_url || queryData.url; // 从响应中获取视频URL

          videoRes = await axios.get(finalDownloadUrl, {
            headers: isThreeUrlMode ? { Authorization: authorization } : {},
            responseType: "arraybuffer",
            timeout: 60 * 1000 * 10, // 60秒超时
          });
          break; // 成功则跳出循环
        } catch (error) {
          lastError = error;
          console.error(`视频下载失败，第 ${i + 1}/${retries} 次尝试:`, error);
          if (i < retries - 1) {
            // 等待后重试，使用指数退避
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1000));
          }
        }
      }

      if (!videoRes) {
        throw new Error(`视频下载失败，已重试 ${retries} 次: ${lastError}`);
      }

      // 将视频buffer转换为base64或直接返回buffer
      const savePath = input.savePath.endsWith(".mp4") ? input.savePath : path.join(input.savePath, `other_${Date.now()}.mp4`);
      await u.oss.writeFile(input.savePath, videoRes.data);

      return { completed: true, url: savePath };
    }
    if (queryData.status === "failed") return { completed: false, error: `任务失败: ${queryData.error || "未知错误"}` };
    // if (queryData.status === "QUEUED" || queryData.status === "RUNNING") return { completed: false };
    return { completed: false };
  });
};
