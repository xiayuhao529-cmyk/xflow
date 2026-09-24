import "../type";
import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { pollTask, validateVideoConfig } from "@/utils/ai/utils";

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.apiKey) throw new Error("缺少API Key");

  // const { owned, images, hasTextType } = validateVideoConfig(input, config);

  const defaultBaseUrl = [
    "https://www.runninghub.cn/openapi/v2/rhart-video-s/image-to-video",
    "https://www.runninghub.cn/openapi/v2/rhart-video-s/image-to-video-pro",
    "https://www.runninghub.cn/openapi/v2/rhart-video-s/text-to-video",
    "https://www.runninghub.cn/openapi/v2/rhart-video-s/text-to-video-pro",
    "https://www.runninghub.cn/openapi/v2/query",
    "https://www.runninghub.cn/openapi/v2/media/upload/binary",
  ].join("|");

  const [image2videoUrl, image2videoProUrl, text2videoUrl, text2videoProUrl, queryUrl, uploadUrl] = (config.baseURL || defaultBaseUrl).split("|");
  const hasTextType = input.mode == "text";
  const isPro = config.model === "sora-2-pro";
  const authorization = `Bearer ${config.apiKey}`;

  // 上传 base64 图片
  const uploadImage = async (base64Image: string): Promise<string> => {
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
    let buffer: Buffer = Buffer.from(base64Data, "base64");
    const MAX_SIZE = 5 * 1024 * 1024;

    if (buffer.length > MAX_SIZE) {
      for (let quality = 90; buffer.length > MAX_SIZE && quality > 10; quality -= 10) {
        buffer = await sharp(buffer).jpeg({ quality, mozjpeg: true }).toBuffer();
      }
      if (buffer.length > MAX_SIZE) {
        const { width = 1920, height = 1080 } = await sharp(buffer).metadata();
        const scale = Math.sqrt(MAX_SIZE / buffer.length);
        buffer = await sharp(buffer)
          .resize({ width: Math.floor(width * scale), height: Math.floor(height * scale), fit: "inside" })
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer();
      }
    }

    const formData = new FormData();
    formData.append("file", buffer, { filename: "image.jpg", contentType: "image/jpeg" });

    const { data } = await axios.post(uploadUrl, formData, {
      headers: { Authorization: authorization },
    });

    if (data.code !== 0 || !data.data?.download_url) {
      throw new Error(`图片上传失败: ${JSON.stringify(data)}`);
    }
    return data.data.download_url;
  };

  // 提交任务
  const submitTask = async (url: string, body: Record<string, unknown>) => {
    const { data } = await axios.post(url, body, {
      headers: { "Content-Type": "application/json", Authorization: authorization },
    });
    if (data.status === "FAILED") throw new Error(`任务提交失败: ${data.errorMessage || "未知错误"}`);
    return { taskId: data.taskId, status: data.status, url: data.results?.[0]?.url };
  };

  const isTextToVideo = (!input.imageBase64 || input.imageBase64.length === 0) && hasTextType;
  const submitUrl = isTextToVideo ? (isPro ? text2videoProUrl : text2videoUrl) : isPro ? image2videoProUrl : image2videoUrl;

  const requestBody: Record<string, unknown> = {
    prompt: input.prompt,
    duration: String(input.duration),
    aspectRatio: input.aspectRatio,
    ...(isTextToVideo ? {} : { imageUrl: await uploadImage(input.imageBase64![0]) }),
  };

  const { taskId } = await submitTask(submitUrl, requestBody);

  return await pollTask(async () => {
    const { data } = await axios.post(
      queryUrl,
      {
        taskId,
      },
      {
        headers: { Authorization: authorization },
      },
    );

    if (data.status === "SUCCESS") {
      return data.results?.length ? { completed: true, url: data.results[0].url } : { completed: false, error: "任务成功但未返回视频链接" };
    }
    if (data.status === "FAILED") return { completed: false, error: `任务失败: ${data.errorMessage || "未知错误"}` };
    if (data.status === "QUEUED" || data.status === "RUNNING") return { completed: false };
    return { completed: false, error: `未知状态: ${data.status}` };
  });
};
