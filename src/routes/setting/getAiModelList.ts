import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import imageModelList from "@/utils/ai/image/modelList";
const router = express.Router();

// 图像模型默认预设（与 modelList 一致，DB 无数据时由后端兜底返回）
function getDefaultImagePresets(): Record<string, { label: string; value: string }[]> {
  const presets: Record<string, { label: string; value: string }[]> = {};
  for (const item of imageModelList) {
    if (!presets[item.manufacturer]) presets[item.manufacturer] = [];
    presets[item.manufacturer].push({ label: item.model, value: item.model });
  }
  return presets;
}

const defaultImagePresets = getDefaultImagePresets();

export default router.post(
  "/",
  validateFields({
    type: z.enum(["text", "image", "video"]),
  }),
  async (req, res) => {
    const { type } = req.body;
    const sqlTableMap = {
      text: "t_textModel",
      image: "t_imageModel",
      video: "t_videoModel",
    };
    const modelLists = await u
      .db(sqlTableMap[type as "image" | "text" | "video"])
      .whereNot("manufacturer", "other")
      .select("id", "manufacturer", "model");
    const result: Record<string, { label: string; value: string }[]> = {};
    for (const row of modelLists) {
      if (!result[row.manufacturer]) result[row.manufacturer] = [];
      result[row.manufacturer].push({ label: row.model, value: row.model });
    }
    if (type === "image") {
      for (const [manufacturer, list] of Object.entries(defaultImagePresets)) {
        if (!result[manufacturer]?.length) result[manufacturer] = list;
      }
    }
    res.status(200).send(success(result));
  },
);
