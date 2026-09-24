import "../type";
import { pollTask } from "@/utils/ai/utils";
import u from "@/utils";
import axios from "axios";
import path from "path";

import * as volcengine from "../adapter/volcengine";
import * as openai from "../adapter/openai";
import * as vidu from "../adapter/vidu";
import * as wan from "../adapter/wan";

// 适配器映射
const modelFn = {
  volcengine,
  vidu,
  openai,
  wan,
} as const;

// 模型名称到适配器的映射（精确匹配）
const modelMapping: Record<string, keyof typeof modelFn> = {
  // Volcengine 火山引擎模型
  "doubao-seedance-1-5-pro-251215": "volcengine",
  "doubao-seedance-1-0-pro-250528": "volcengine",
  "Seedance-2.0": "volcengine",
  // Vidu 模型
  ViduQ2: "vidu",
  "ViduQ2-turbo": "vidu",
  "ViduQ2-pro": "vidu",
  "ViduQ3-pro": "vidu",
  // OpenAI 模型
  sora2: "openai",
  "sora2-pro": "openai",
  "gpt-video": "openai",
  // 万象/Wan 模型
  "Wan2.6-T2V": "wan",
  "Wan2.6-I2V": "wan",
};

// 模型名称关键字到适配器的映射（模糊匹配）
const modelKeywords: Array<{ keywords: string[]; adapter: keyof typeof modelFn }> = [
  { keywords: ["doubao", "volcengine", "seedance"], adapter: "volcengine" },
  { keywords: ["vidu"], adapter: "vidu" },
  { keywords: ["sora", "openai", "gpt"], adapter: "openai" },
  { keywords: ["wan", "wanx"], adapter: "wan" },
];

/**
 * 根据模型名称获取对应的适配器
 */
function getModelAdapter(modelName: string) {
  // 1. 先尝试精确匹配
  const exactMatch = modelMapping[modelName.toLowerCase()];
  if (exactMatch) {
    return modelFn[exactMatch];
  }

  // 2. 尝试关键字模糊匹配
  const lowerModelName = modelName.toLowerCase();
  for (const { keywords, adapter } of modelKeywords) {
    if (keywords.some((kw) => lowerModelName.includes(kw.toLowerCase()))) {
      return modelFn[adapter];
    }
  }

  // 3. 如果模型名称本身就是适配器名称
  if (modelName in modelFn) {
    return modelFn[modelName as keyof typeof modelFn];
  }

  return modelFn["wan"];
}
function template(replaceObj: Record<string, any>, url: string) {
  return url.replace(/\{(\w+)\}/g, (match, varName) => {
    return replaceObj.hasOwnProperty(varName) ? replaceObj[varName] : match;
  });
}
export default async (input: VideoConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  // 根据模型名称获取对应的适配器
  const modelAdapter = getModelAdapter(config.model);

  const { requestUrl, queryUrl, downLoadUrl = null } = modelAdapter.buildReqUrl(config.baseURL);
  const taskBody = await modelAdapter.buildReqBody(input, config);

  const apiKey = config.apiKey.replace("Bearer ", "");
  try {
    const { data } = await axios.post(requestUrl, taskBody, { headers: { Authorization: `Bearer ${apiKey}` } });
    console.log("%c Line:91 🌽 data", "background:#3f7cff", data);

    const taskId = data.id ?? data.taskId ?? data.task_id ?? data.data;

    if (!taskId) throw new Error(`任务提交失败: ${data ? JSON.stringify(data) : "未知错误"}`);

    return await pollTask(async () => {
      const { data: queryData } = await axios.get(template({ id: taskId }, queryUrl), {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      console.log("%c Line:99 🥝 queryData", "background:#e41a6a", queryData);

      // const { status, result_url, fail_reason } = queryData.data || {};

      const status = queryData?.status ?? queryData?.data?.status;
      const result_url = queryData?.metadata?.url ?? queryData?.data?.result_url;
      const fail_reason = queryData?.data?.fail_reason ?? queryData?.data;

      switch (status) {
        case "completed":
        case "SUCCESS":
        case "success":
          if (downLoadUrl) {
            // 下载视频，带重试机制
            let videoRes;
            let retries = 3;
            let lastError;

            for (let i = 0; i < retries; i++) {
              try {
                // 构建下载URL
                const finalDownloadUrl = downLoadUrl
                  ? template({ id: taskId }, downLoadUrl)
                  : queryData.video_url || queryData.url || queryData.metadata.url; // 从响应中获取视频URL

                videoRes = await axios.get(finalDownloadUrl, {
                  headers: { Authorization: `Bearer ${apiKey}` },
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
          } else {
            return { completed: true, url: result_url };
          }
      }
      if (status === "FAILURE") {
        return { completed: false, error: fail_reason ? fail_reason : "视频生成失败" };
      }

      if (status === "SUCCESS") {
        return { completed: true, url: result_url };
      }

      return { completed: false };
    });
  } catch (error: any) {
    const msg = u.error(error).message || "图片生成失败";

    throw new Error(msg);
  }
};
