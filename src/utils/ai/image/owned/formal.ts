import "../type";
import { generateImage, generateText, ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { pollTask } from "@/utils/ai/utils";
import u from "@/utils";
import axios from "axios";
import * as volcengine from "../adapter/volcengine";
const modelFn = {
  volcengine,
} as const;
function template(replaceObj: Record<string, any>, url: string) {
  return url.replace(/\{(\w+)\}/g, (match, varName) => {
    return replaceObj.hasOwnProperty(varName) ? replaceObj[varName] : match;
  });
}
export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  const { requestUrl, queryUrl = null } = modelFn["volcengine"].buildReqUrl(config?.baseURL);
  const taskBody = modelFn["volcengine"].buildReqBody(input, config);

  const apiKey = config.apiKey.replace("Bearer ", "");
  try {
    const { data } = await axios.post(requestUrl, taskBody, { headers: { Authorization: `Bearer ${apiKey}` } });

    if (queryUrl) {
      if (data.code != "success") throw new Error(`任务提交失败: ${data || "未知错误"}`);
      const taskId = data.data;

      return await pollTask(async () => {
        const { data: queryData } = await axios.get(template({ id: taskId }, queryUrl), {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        const { status, result_url, fail_reason } = queryData.data || {};

        if (status === "FAILURE") {
          return { completed: false, error: fail_reason ?? "图片生成失败" };
        }

        if (status === "SUCCESS") {
          return { completed: true, url: result_url };
        }

        return { completed: false };
      });
    } else {
      return data.data[0]?.url;
    }
  } catch (error: any) {
    const msg = u.error(error).message || "图片生成失败";
    throw new Error(msg);
  }
};

async function urlToBase64(url: string): Promise<string> {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  const base64 = Buffer.from(res.data).toString("base64");
  const mimeType = res.headers["content-type"] || "image/png";
  return `data:${mimeType};base64,${base64}`;
}
