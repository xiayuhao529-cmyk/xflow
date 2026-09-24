import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 保存资产图片
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    filePath: z.string().optional().nullable(),
    prompt: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { id, base64, filePath, prompt, projectId } = req.body;

    let savePath: string | undefined;
    let imageUrl: string | undefined;

    if (base64) {
      // base64图片上传逻辑
      const matches = base64.match(/^data:image\/\w+;base64,(.+)$/);
      const realBase64 = matches ? matches[1] : base64;
      // 生成新的图片路径
      savePath = `/${projectId}/assets/${uuidv4()}.png`;
      // 写入文件
      await u.oss.writeFile(savePath, Buffer.from(realBase64, "base64"));
      // 插入图片表
      await u.db("t_image").insert({
        assetsId: id,
        filePath: savePath,
        type: "image/png",
      });
      imageUrl = savePath; // 新图片路径
    } else if (filePath) {
      // 前端传入已存在图片路径
      try {
        savePath = new URL(filePath).pathname;
      } catch {
        savePath = filePath;
      }

      // 检查图片表里是否有这条图片
      // const selectedImage = await u.db("t_image").where("filePath", savePath).first();
      // if (!selectedImage) {
      //   return res.status(500).send({ success: false, message: "所选图片不存在，请重新生成或选定图片" });
      // }
      imageUrl = savePath;
    }

    // 查旧资产图片
    const oldAsset = await u.db("t_assets").where("id", id).select("filePath", "type").first();

    // 保存新旧图片差异和插临时表逻辑
    if (imageUrl && ((oldAsset?.filePath && oldAsset.filePath !== imageUrl) || (!oldAsset?.filePath && imageUrl))) {
      // 新图片保存，移除 t_image 表
      await u.db("t_image").where("filePath", imageUrl).delete();

      // 原图片如果存在、且不在 t_image 表，插入临时表
      if (oldAsset?.filePath) {
        const oldInTemp = await u.db("t_image").where("filePath", oldAsset.filePath).first();
        if (!oldInTemp) {
          await u.db("t_image").insert({
            assetsId: id,
            filePath: oldAsset.filePath,
            type: oldAsset.type,
          });
        }
      }

      // 更新资产表图片为新图片
      await u.db("t_assets").where("id", id).update({ filePath: imageUrl });
    }

    // 更新提示信息
    if (prompt !== undefined && prompt !== null && prompt !== "") {
      await u.db("t_assets").where("id", id).update({ prompt });
    }

    res.status(200).send(success({ message: "保存资产图片成功" }));
  },
);
