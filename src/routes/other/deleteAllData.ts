import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

// 删除数据库表数据
export default router.post("/", async (req, res) => {
  const projects = await u.db("t_project").select("id");

  const projectIds = projects.map((project) => project.id);

  await Promise.all(
    projectIds.map(async (id) => {
      try {
        await u.oss.deleteDirectory(String(id));
      } catch (error) {
        console.error(`删除OSS文件失败，项目ID: ${id}`, error);
      }
    }),
  );

  // await initDB(db, true);

  res.status(200).send(success("清空数据库成功"));
});
