import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

// 图片编辑
export default router.post(
  "/",
  validateFields({
    filePath: z.object(),
    prompt: z.string(),
    projectId: z.number(),
    assetsId: z.any(),
  }),
  async (req, res) => {
    const { filePath, prompt, projectId, assetsId } = req.body;
    //拿到图片尺寸
    const projectInfo = await u.db("t_project").where({ id: projectId }).first();

    let data = await u.editImage(filePath, prompt, projectId,projectInfo?.videoRatio!);
    const returnData: {
      id: number | null;
      url: string | null;
    } = {
      id: null,
      url: null,
    };
    if (assetsId) {
      const [id] = await u.db("t_image").insert({
        filePath: data,
        assetsId: assetsId,
      });
      returnData.id = id!;
    }
    returnData.url = await u.oss.getFileUrl(data);

    res.status(200).send(success(returnData));
  }
);
