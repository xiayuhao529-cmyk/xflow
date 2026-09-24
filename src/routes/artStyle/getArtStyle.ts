import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string(),
  }),
  async (req, res) => {
    const { name } = req.body;
    const data = await u.db("t_artStyle").where("name", name).select("styles").first();
    const styles = data?.styles ? JSON.parse(data.styles) : [];
    res.status(200).send(success(styles));
  },
);
