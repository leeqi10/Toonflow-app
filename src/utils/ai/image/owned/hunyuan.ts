import "../type";
import u from "@/utils";
import { pollTask } from "@/utils/ai/utils";

// 腾讯云 API 3.0 SDK（aiart 混元生图）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tencentcloud = require("tencentcloud-sdk-nodejs");
const raw = tencentcloud.aiart ?? tencentcloud.default?.aiart;
const AiartClient = raw?.v20221229?.Client as
  | (new (options: {
      credential: { secretId: string; secretKey: string };
      region: string;
    }) => {
      SubmitTextToImageJob(params: {
        Prompt: string;
        Resolution?: string;
        Revise?: number;
      }): Promise<{ JobId?: string } | { Response?: { JobId?: string } }>;
      QueryTextToImageJob(params: { JobId: string }): Promise<{
        JobStatusCode?: string;
        JobErrorMsg?: string;
        ResultImage?: string[];
        Response?: { JobStatusCode?: string; JobErrorMsg?: string; ResultImage?: string[] };
      }>;
    })
  | undefined;

// 由于腾讯混元同一账号同一时间只允许 1 个生图任务在执行，
// 这里在应用层按 secretId 做一个简单的串行队列，避免并发请求直接打满配额。
const tencentTaskQueues = new Map<string, Promise<unknown>>();

async function runInTencentQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tencentTaskQueues.get(key) ?? Promise.resolve();

  // 串行执行：等待前一个任务完成后再执行当前任务
  const current = prev
    .catch(() => {
      // 上一个任务失败不影响后续任务执行
    })
    .then(fn)
    .finally(() => {
      // 只有当队列中仍指向当前 Promise 时才清理，避免误删后续任务
      if (tencentTaskQueues.get(key) === current) {
        tencentTaskQueues.delete(key);
      }
    });

  tencentTaskQueues.set(key, current);
  return current;
}

function parseTencentCredential(apiKey: string): { secretId: string; secretKey: string } {
  const trimmed = (apiKey || "").trim();
  if (!trimmed) throw new Error("腾讯混元：请配置 SecretId 与 SecretKey");
  try {
    const parsed = JSON.parse(trimmed) as { secretId?: string; secretKey?: string };
    if (typeof parsed?.secretId !== "string" || typeof parsed?.secretKey !== "string") {
      throw new Error("腾讯混元：apiKey 须为 JSON 格式 { secretId, secretKey }");
    }
    return { secretId: parsed.secretId, secretKey: parsed.secretKey };
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error("腾讯混元：apiKey 格式错误，请使用 SecretId/SecretKey 配置并保存");
    }
    throw e;
  }
}

/** 将 aspectRatio + size 映射为腾讯文档允许的 Resolution（宽:高） */
function mapResolution(aspectRatio: string, _size: string): string {
  const map: Record<string, string> = {
    "16:9": "1024:576",
    "9:16": "576:1024",
    "1:1": "1024:1024",
  };
  return map[aspectRatio] ?? "1024:1024";
}

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.apiKey) throw new Error("缺少 API Key（腾讯混元需配置 SecretId/SecretKey）");
  if (!input.prompt) throw new Error("缺少提示词，prompt 为必填项");

  const { secretId, secretKey } = parseTencentCredential(config.apiKey);
  const region = (config.baseURL || "ap-guangzhou").trim() || "ap-guangzhou";
  const resolution = mapResolution(input.aspectRatio, input.size);
  const fullPrompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;

  if (!AiartClient) {
    throw new Error("腾讯云 SDK 未正确加载，请确认已安装 tencentcloud-sdk-nodejs");
  }

  const client = new AiartClient({
    credential: { secretId, secretKey },
    region,
  });

  // 使用应用层队列串行化同一账号的生图任务，避免出现“已达到 1 个任务上限”的错误
  return runInTencentQueue(secretId, async () => {
    try {
      console.log("[tencent-hunyuan] submit start", {
        region,
        resolution,
        hasSystemPrompt: !!input.systemPrompt,
        promptLength: fullPrompt.length,
      });
      const submitRes = await client.SubmitTextToImageJob({
        Prompt: fullPrompt,
        Resolution: resolution,
        Revise: 0,
      });
      const jobId =
        (submitRes && "JobId" in submitRes && submitRes.JobId) ||
        (submitRes && "Response" in submitRes && (submitRes as { Response?: { JobId?: string } }).Response?.JobId);
      if (!jobId) throw new Error("腾讯混元：未返回任务 ID");
      console.log("[tencent-hunyuan] submit success", { jobId, resolution });

      // 腾讯混元任务有排队和执行时间，这里设置一个相对合理的整体超时时间，避免前端长时间卡在“生成中”
      // 120 次 * 2s = 4 分钟
      return await pollTask(
        async () => {
          const queryRes = await client.QueryTextToImageJob({ JobId: jobId });
          const res = queryRes && "Response" in queryRes ? (queryRes as { Response?: typeof queryRes }).Response : queryRes;
          const status = res?.JobStatusCode;
          const errorMsg = res?.JobErrorMsg;
          const images = res?.ResultImage;

          if (status === "4") {
            console.warn("[tencent-hunyuan] task failed", { jobId, status, errorMsg });
            return { completed: false, error: errorMsg || "腾讯混元：任务处理失败" };
          }
          if (status === "5" && images?.length) {
            console.log("[tencent-hunyuan] task success", { jobId, status, imageCount: images.length });
            return { completed: true, url: images[0] };
          }
          console.log("[tencent-hunyuan] task polling", { jobId, status });
          return { completed: false };
        },
        120,
        2000,
      );
    } catch (err) {
      console.error("[tencent-hunyuan] error", u.error(err));
      const msg = u.error(err).message || "腾讯混元图片生成失败";
      throw new Error(msg);
    }
  });
};
