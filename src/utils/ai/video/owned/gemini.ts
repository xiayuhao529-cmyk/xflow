import "../type";
import fs from "fs";
import path from "path";
import axios from "axios";
import { pollTask, validateVideoConfig } from "@/utils/ai/utils";

const buildInlineImage = (data: string) => ({ inlineData: { mimeType: "image/png", data } });

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  // const { owned, images, hasStartEndType } = validateVideoConfig(input, config);

  const defaultBaseUrl = [
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning",
    "https://generativelanguage.googleapis.com/v1beta/{name}",
  ].join("|");

  const [submitUrl, queryUrl] = (config.baseURL || defaultBaseUrl).split("|");

  const headers = { "x-goog-api-key": config.apiKey };

  const instance: Record<string, any> = { prompt: input.prompt };
  const parameters: Record<string, any> = {
    aspectRatio: input.aspectRatio,
    durationSeconds: +input.duration,
    ...(input.resolution !== "720p" && { resolution: input.resolution }),
  };

  // 根据图片数量和模型能力决定图片用法
  const len = input.imageBase64 ? input.imageBase64.length : 0;
  const hasRef = input.mode == "multi";
  const hasSingle = input.mode == "single";
  const hasStartEndType = input.mode === "startEnd";
  if (len === 2 && hasStartEndType) {
    instance.image = buildInlineImage(input.imageBase64![0]);
    parameters.lastFrame = buildInlineImage(input.imageBase64![1]);
  } else if (len === 1 && (hasSingle || hasStartEndType)) {
    instance.image = buildInlineImage(input.imageBase64![0]);
  } else if (len >= 1 && len <= 3 && hasRef) {
    parameters.referenceImages = input.imageBase64!.map((img) => ({ image: buildInlineImage(img), referenceType: "asset" }));
  }

  const { data } = await axios.post(
    submitUrl.replace("{model}", config.model),
    { instances: [instance], parameters },
    { headers: { ...headers, "Content-Type": "application/json" } },
  );

  if (!data.name) throw new Error("未获取到操作名称");

  return pollTask(async () => {
    const { data: status } = await axios.get(queryUrl.replace("{name}", data.name), { headers });

    const { done, response, error } = status;

    if (!done) return { completed: false };
    if (error) return { completed: false, error: `任务失败: ${error.message || JSON.stringify(error)}` };

    const videoUri = response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;

    if (!videoUri) return { completed: false, error: "未获取到视频下载地址" };

    const videoRes = await axios.get(videoUri, { headers, responseType: "arraybuffer", maxRedirects: 5 });
    const savePath = input.savePath.endsWith(".mp4") ? input.savePath : path.join(input.savePath, `gemini_${Date.now()}.mp4`);
    fs.writeFileSync(savePath, Buffer.from(videoRes.data));

    return { completed: true, url: savePath };
  });
};
