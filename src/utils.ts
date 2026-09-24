import db from "@/utils/db";
import oss from "@/utils/oss";
// import * as ai from "@/utils/ai";
import editImage from "@/utils/editImage";
import number2Chinese from "@/utils/number2Chinese";
import deleteOutline from "@/utils/deleteOutline";
import getConfig from "./utils/getConfig";
import { v4 as uuid } from "uuid";
import error from "@/utils/error";
import * as imageTools from "@/utils/imageTools";

import AIText from "@/utils/ai/text/index";
import AIImage from "@/utils/ai/image/index";
import AIVideo from "@/utils/ai/video/index";

import getPromptAi from "./utils/getPromptAi";
export default {
  db,
  oss,
  ai: {
    text: AIText,
    image: AIImage,
    video: AIVideo,
  },
  editImage,
  number2Chinese,
  deleteOutline,
  getConfig,
  uuid,
  error,
  imageTools,
  getPromptAi,
};
