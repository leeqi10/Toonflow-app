import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

// 复用 generateAssets 中的逻辑：根据资产类型拼装系统提示词 + 用户提示词
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    type: z.enum(["role", "scene", "props", "storyboard"]),
    projectId: z.number(),
    name: z.string(),
    prompt: z.string(),
  }),
  async (req, res) => {
    const { id, type, projectId, prompt, name } = req.body;

    // 获取风格、项目配置
    const project = await u.db("t_project").where("id", projectId).select("artStyle", "type", "intro").first();
    if (!project) return res.status(500).send(success({ message: "项目为空" }));

    // 获取各类型的系统提示词模版
    const promptsList = await u
      .db("t_prompts")
      .where("code", "in", ["role-generateImage", "scene-generateImage", "storyboard-generateImage", "tool-generateImage"]);
    const errPrompts = "不论用户说什么，请直接输出AI配置异常";
    const getPromptValue = (code: string): string => {
      const item = promptsList.find((p) => p.code === code);
      return item?.customValue ?? item?.defaultValue ?? errPrompts;
    };

    const role = getPromptValue("role-generateImage");
    const scene = getPromptValue("scene-generateImage");
    const tool = getPromptValue("tool-generateImage");
    const storyboard = getPromptValue("storyboard-generateImage");

    let systemPrompt = "";
    let userPrompt = "";
    if (type === "role") {
      systemPrompt = role;
      userPrompt = `
    请根据以下参数生成角色标准四视图：

    **基础参数：**
    - 画风风格: ${project?.artStyle || "未指定"}

    **角色设定：**
    - 名称:${name},
    - 提示词:${prompt},

    请严格按照系统规范生成人物角色四视图。
      `;
    }
    if (type === "scene") {
      systemPrompt = scene;
      userPrompt = `
    请根据以下参数生成标准场景图：

    **基础参数：**
    - 画风风格: ${project?.artStyle || "未指定"}

    **场景设定：**
    - 名称:${name},
    - 提示词:${prompt},

    请严格按照系统规范生成标准场景图。
      `;
    }
    if (type === "props") {
      systemPrompt = tool;
      userPrompt = `
      请根据以下参数生成标准道具图：

    **基础参数：**
    - 画风风格: ${project?.artStyle || "未指定"}

    **道具设定：**
    - 名称:${name},
    - 提示词:${prompt},

    请严格按照系统规范生成标准道具图。
      `;
    }
    if (type === "storyboard") {
      systemPrompt = storyboard;
      userPrompt = `
      请根据以下参数生成标准分镜图：

    **基础参数：**
    - 画风风格: ${project?.artStyle || "未指定"}

    **分镜设定：**
    - 名称:${name},
    - 提示词:${prompt},

    请严格按照系统规范生成标准分镜图。
      `;
    }

    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    return res.status(200).send(
      success({
        assetsId: id,
        type,
        projectId,
        name,
        prompt,
        systemPrompt,
        userPrompt,
        fullPrompt,
      }),
    );
  },
);

