import { db } from "./db";
import modelList from "./ai/text/modelList";
interface AiConfig {
  model?: string;
  apiKey: string;
  baseURL?: string;
  manufacturer: string;
}

export default async function getPromptAi(key: string): Promise<AiConfig | {}> {
  const matchedModel = modelList.find((m) => m.model === key);

  if (matchedModel) {
    const manufacturerUpperCase = matchedModel.manufacturer.toUpperCase();
    const apiKey = process.env[`AI_${manufacturerUpperCase}_KEY`] || "";
    const baseURL = process.env[`AI_${manufacturerUpperCase}_URL`] || "";

    return {
      model: matchedModel.model,
      apiKey: apiKey,
      baseURL: baseURL,
      manufacturer: matchedModel.manufacturer,
    } as AiConfig;
  }

  const aiConfigData = await db("t_aiModelMap")
    .leftJoin("t_config", "t_config.id", "t_aiModelMap.configId")
    .where("t_aiModelMap.key", key)
    .select("t_config.model", "t_config.apiKey", "t_config.baseUrl as baseURL", "t_config.manufacturer")
    .first();

  if (aiConfigData) {
    return aiConfigData as AiConfig;
  } else return {};
}
