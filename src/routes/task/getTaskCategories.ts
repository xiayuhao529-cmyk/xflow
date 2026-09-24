import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { number, z } from "zod";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
  }),
  async (req, res) => {
    const data = await u.db("t_myTasks").where("projectId", req.body.projectId).select("taskClass").groupBy("taskClass");
    res.status(200).send(success(data));
  },
);
