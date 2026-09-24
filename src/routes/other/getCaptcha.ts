import express from "express";
import { success } from "@/lib/responseFormat";
import { md5 } from "js-md5";
const router = express.Router();

// 获取验证码
export default router.get("/", async (req, res) => {
  const data: any = { svg: "<svg></svg>", captcha: md5("123") };
  if (req.app.get("env") === "dev") {
    data.key = 2;
  }
  res.status(200).send(success(data));
});
