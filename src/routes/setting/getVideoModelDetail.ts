import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const videoData = await u.db("t_videoModel").select("*");
  const allData = videoData.map((i) => {
    const durationResolutionMap = JSON.parse(i.durationResolutionMap ?? "[]");
    const aspectRatio = JSON.parse(i.aspectRatio ?? "[]");
    const type = JSON.parse(i.type ?? "[]");
    return {
      ...i,
      durationResolutionMap,
      aspectRatio,
      type,
      audio: i.audio === 1,
    };
  });

  const otherConfig = {
    manufacturer: "other",
    model: "",
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] }],
    aspectRatio: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
    type: ["text", "endFrameOptional", "singleImage", "multiImage"],
    audio: true,
  };
  const returnData = [otherConfig, ...allData];
  res.status(200).send(success(returnData));
});
