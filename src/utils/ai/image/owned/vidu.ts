import "../type";
import axios from "axios";
import u from "@/utils";
import { pollTask } from "@/utils/ai/utils";
function getApiUrl(apiUrl: string) {
  if (apiUrl.includes("|")) {
    const parts = apiUrl.split("|");
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      throw new Error("url 格式错误，请使用 url1|url2 格式");
    }
    return { requestUrl: parts[0].trim(), queryUrl: parts[1].trim() };
  }
  throw new Error("请填写正确的url");
}
function template(replaceObj: Record<string, any>, url: string) {
  return url.replace(/\{(\w+)\}/g, (match, varName) => {
    return replaceObj.hasOwnProperty(varName) ? replaceObj[varName] : match;
  });
}
export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");
  const apiKey = "Token " + config.apiKey.replace(/Token\s+/g, "").trim();
  const viduq2Ratio = ["16:9", "9:16", "1:1", "3:4", "4:3", "21:9", "2:3", "3:2"];
  const viduq1Ratio = ["16:9", "9:16", "1:1", "3:4", "4:3"];
  let images: string[] = [];
  const baseImages = input.imageBase64;
  // 如果图片总数大于7，合并第7张及以后的图片
  if (baseImages) {
    if (baseImages.length > 7) {
      // 前6张原图
      images = baseImages.slice(0, 6);
      // 第7张及以后的图片进行合并
      const mergeImageList = baseImages.slice(6); // 注意此处使用slice，不会改变原数组
      const mergedImage = await u.imageTools.mergeImages(mergeImageList, "10mb");
      images.push(mergedImage);
    } else {
      // 不足7张，直接全部加入
      images = baseImages;
    }
  }

  let size = "1080p";
  if (config.model == "viduq1") {
    if (!images.length) throw new Error(`viduq1 进行图片生成必须传入一张图片`);
    if (!viduq1Ratio.includes(input.aspectRatio)) throw new Error("不支持的图片比例:" + input.aspectRatio);
    size = "1080p";
  } else {
    if (input.size == "1K") size = "1080p";
    else size = input.size;
    if (!viduq2Ratio.includes(input.aspectRatio)) throw new Error("不支持的图片比例:" + input.aspectRatio);
  }

  const body: Record<string, any> = {
    model: config.model,
    prompt: input.prompt,
    aspect_ratio: input.aspectRatio,
    resolution: size,
    ...(images.length && { images: images }),
  };

  const urlObj = getApiUrl(config.baseURL! ?? "https://api.vidu.cn/ent/v2/reference2image|https://api.vidu.cn/ent/v2/tasks/{id}/creations");

  try {
    const { data } = await axios.post(urlObj.requestUrl, body, { headers: { Authorization: apiKey } });

    const queryUrl = template({ id: data.task_id }, urlObj.queryUrl);

    return await pollTask(async () => {
      const { data: queryData } = await axios.get(queryUrl, { headers: { Authorization: apiKey } });

      const { state, err_code, creations } = queryData || {};

      if (state === "failed") {
        return { completed: false, error: err_code || "图片生成失败" };
      }

      if (state === "success") {
        return { completed: true, url: creations?.[0]?.url };
      }

      return { completed: false };
    });
  } catch (error: any) {
    const msg = u.error(error).message || "vidu 图片生成失败";
    throw new Error(msg);
  }
};
