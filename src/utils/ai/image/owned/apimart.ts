import axios from "axios";
import { pollTask } from "@/utils/ai/utils";


export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.apiKey) throw new Error("缺少API Key");
  const apiKey = config.apiKey.replace("Bearer ", "");
  const taskRes = await axios.post(
    `https://api.apimart.ai/v1/images/generations`,
    { model: "gemini-3-pro-image-preview", prompt: input.prompt, size: input.aspectRatio, n: 1, resolution: input.size },
    { headers: { Authorization: apiKey } },
  );

  if (taskRes.data.code !== 200 || !taskRes.data.data?.[0]?.task_id) throw new Error("任务创建失败: " + JSON.stringify(taskRes.data));

  const taskId = taskRes.data.data[0].task_id;
  return pollTask(async () => {
    const res = await axios.get(`https://api.apimart.ai/v1/tasks/${taskId}`, { headers: { Authorization: apiKey }, params: { language: "en" } });
    if (res.data.code !== 200) return { completed: false, error: `查询失败: ${JSON.stringify(res.data)}` };
    const { status, result } = res.data.data;
    if (status === "completed") return { completed: true, url: result?.images?.[0]?.url?.[0] };
    if (status === "failed" || status === "cancelled") return { completed: false, error: `任务${status}` };
    return { completed: false };
  });
};
