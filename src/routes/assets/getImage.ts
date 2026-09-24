import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取生成图片
export default router.post(
  "/",
  validateFields({
    assetsId: z.number(),
  }),
  async (req, res) => {
    const { assetsId } = req.body;

    const assets = await u.db("t_assets").where("id", assetsId).select("id", "filePath", "scriptId", "type", "state").first();

    const tempAssets = await u.db("t_image").where("assetsId", assetsId).select("id", "filePath", "assetsId", "type", "state");

    for (const item of tempAssets) {
      if (item.filePath) {
        item.filePath = await u.oss.getFileUrl(item.filePath);
      } else {
        item.filePath = "";
      }
    }

    const data = {
      id: assets!.id,
      state: assets!.state,
      filePath: assets!.filePath ? await u.oss.getFileUrl(assets!.filePath) : "",
      scriptId: assets!.scriptId,
      tempAssets,
    };

    res.status(200).send(success(data));
  },
);
