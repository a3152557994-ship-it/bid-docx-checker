/**
 * 标书排雷王 BidGuard Pro v2.0 — Cloudflare Worker 云端插件 API + MCP Server
 * 专为「扣子 Coze 自定义插件」「支付宝百宝箱 Tbox 自定义插件 / MCP」打造。
 *
 * 隐私铁律：纯内存流式解压 .docx XML 并实时返回排雷结果，不落盘、不写数据库、不记录标书原文日志。
 *
 * Endpoints:
 *   GET  /                    -> 服务概览
 *   GET  /health              -> 存活探针
 *   GET  /openapi.json        -> 标准 OpenAPI 3.0.1（一键导入扣子 Coze / 支付宝百宝箱）
 *   POST /api/v1/audit-docx   -> 标书 .docx(URL/Base64) 或纯文本六大废标排雷 + ★条款核对
 *   POST /api/v1/rubric-check -> 招标实质性条款(★)/评分细则专项逐条响应核对
 *   POST /mcp                 -> 标准 MCP Streamable HTTP 端点（适配支付宝百宝箱/扣子 MCP）
 */

import {
  auditDocxBuffer,
  auditPlainText,
  exportClearanceChecklist,
  verifyLicenseToken,
  PRODUCT_SLUG,
} from "../src/docx-auditor.mjs";

const SERVICE_NAME = "bidguard-pro-api";
const SERVICE_VERSION = "2.0.0";
const MAX_DOCX_BYTES = 15 * 1024 * 1024; // 15 MB safety ceiling

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-License-Key, X-Plugin-Secret",
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function isSafePublicHttpsUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function decodeBase64Bytes(b64) {
  const cleaned = String(b64 || "")
    .replace(/^data:[^;]+;base64,/i, "")
    .replace(/\s+/g, "");
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function fetchDocxBytesFromUrl(docxUrl, fetcher = globalThis.fetch) {
  if (!isSafePublicHttpsUrl(docxUrl)) {
    throw new Error("docx_url 必须是公网可访问的 HTTPS 文件链接（禁止内网/本地地址）。");
  }
  const res = await fetcher(docxUrl, {
    method: "GET",
    headers: { "User-Agent": "BidGuard-Pro-Plugin/2.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`无法下载标书 .docx 文件（HTTP ${res.status}），请确认文件链接未过期。`);
  }
  const contentLen = Number(res.headers.get("content-length") || 0);
  if (contentLen > MAX_DOCX_BYTES) {
    throw new Error(`标书文件超过 15MB 限制（当前 ${(contentLen / 1024 / 1024).toFixed(1)}MB），请先压缩插图后重试。`);
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_DOCX_BYTES) {
    throw new Error("标书文件超过 15MB 限制，请压缩图片后重试。");
  }
  return new Uint8Array(ab);
}

async function resolveProEntitlement(request, body = {}, env = {}) {
  // Path 1: Trusted Coze / Alipay Tbox workflow header after Alipay payment confirmation
  const pluginSecret = env.PLUGIN_SHARED_SECRET || "";
  const headerSecret = request.headers.get("x-plugin-secret") || "";
  if (pluginSecret && headerSecret && headerSecret === pluginSecret && body.paid_order_verified === true) {
    return { isPro: true, provider: "platform_alipay_verified" };
  }

  // Path 2: Offline Ed25519 OPC1.<payload>.<sig> license key
  const auth = request.headers.get("authorization") || "";
  const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const key = String(body.license_key || request.headers.get("x-license-key") || bearer || "").trim();
  if (key.startsWith("OPC1.")) {
    const check = await verifyLicenseToken(key, {
      expectedProduct: PRODUCT_SLUG,
      publicSpkiBase64: env.BIDGUARD_PUBLIC_KEY_SPKI,
    });
    if (check.valid) {
      return { isPro: true, provider: "opc1", payload: check.payload };
    }
    return { isPro: false, reason: check.reason };
  }

  if (body.is_pro === false) {
    return { isPro: false, reason: "EXPLICIT_PREVIEW" };
  }

  return { isPro: true, provider: "open_free" };
}

export function buildBidGuardOpenApi(origin) {
  return {
    openapi: "3.0.1",
    info: {
      title: "标书排雷王 BidGuard Pro 招投标废标项确定性核验 API",
      description:
        "专为中国政府采购与工程招投标打造的确定性标书排雷插件。穿透 Word(.docx) 正文、页眉、页脚与报价表格，精确换算人民币大小写分位差额、排查串名/工期冲突/占位符/签章缺失/资质过期，并核对招标★星号实质性条款漏项。纯内存解析，零字节落盘。",
      version: SERVICE_VERSION,
    },
    servers: [{ url: origin }],
    paths: {
      "/api/v1/audit-docx": {
        post: {
          operationId: "auditBidDocument",
          summary: "标书废标项六大雷区 + 评分条款全量交叉排雷",
          description:
            "传入用户上传的 .docx 标书临时 HTTPS 链接（docx_url）或纯文本段落（tender_text），自动执行人民币大小写精确分位换算、页眉页脚串名检测、工期冲突检测、占位符扫描、法定签章锚点检测、资质过期预警及★条款核对。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    docx_url: {
                      type: "string",
                      description: "用户上传 .docx 标书后生成的公网 HTTPS 下载链接（与 tender_text 二选一）",
                    },
                    docx_base64: {
                      type: "string",
                      description: "可选：.docx 文件 Base64 编码内容",
                    },
                    tender_text: {
                      type: "string",
                      description: "可选：标书正文/报价函/资质页纯文本或 OCR 识别文本（与 docx_url 二选一）",
                    },
                    bid_date: {
                      type: "string",
                      description: "开标日期基准，格式 YYYY-MM-DD（用于判定企业资质证书是否已过期），如 2026-11-30",
                    },
                    expected_purchaser: {
                      type: "string",
                      description: "本次招标的正确采购人/招标人全称（用于揪出页眉页脚旧标书串名）",
                    },
                    expected_bidder: {
                      type: "string",
                      description: "本次投标人本公司全称",
                    },
                    expected_project_name: {
                      type: "string",
                      description: "本次招标的正确项目全称",
                    },
                    rubric_items: {
                      type: "array",
                      items: { type: "string" },
                      description: "可选：招标文件要求逐条响应的 ★ 实质性条款或评分细则列表",
                    },
                    license_key: {
                      type: "string",
                      description: "可选：Pro 激活码（OPC1. 开头）；留空则返回免费体验体检报告（含前2处精确定位与剩余隐藏雷区计数）",
                    },
                    paid_order_verified: {
                      type: "boolean",
                      description: "仅由扣子/支付宝支付工作流验单通过后传入 true（需配 X-Plugin-Secret）",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "返回确定性标书排雷体检报告、安全分、致命废标明细及可选《开标前逐项清零核对单》",
            },
          },
        },
      },
      "/api/v1/rubric-check": {
        post: {
          operationId: "auditBidRubric",
          summary: "招标文件 ★ 实质性星号条款与评分细则漏项核对",
          description: "专门核对投标文件是否漏答招标文件规定的 ★ 一票否决实质性条款与高分评标点。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["rubric_items"],
                  properties: {
                    docx_url: { type: "string", description: "投标文件 .docx 公网 HTTPS 链接" },
                    tender_text: { type: "string", description: "投标文件纯文本（与 docx_url 二选一）" },
                    rubric_items: {
                      type: "array",
                      items: { type: "string" },
                      description: "招标文件要求核对的 ★ 实质性条款或评分细则数组",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "逐条响应核对结果与漏项预警" },
          },
        },
      },
    },
  };
}

export const BIDGUARD_MCP_TOOLS = [
  {
    name: "audit_bid_document",
    description:
      "标书排雷王确定性核验引擎：解析 .docx（支持 docx_url / docx_base64）或纯文本（tender_text），精准核验人民币大小写分位差额、页眉页脚串名、工期冲突、占位符残留、法定签章缺失、资质过期及★实质性条款漏项。",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: buildBidGuardOpenApi("https://example.workers.dev").paths["/api/v1/audit-docx"].post.requestBody.content["application/json"].schema,
  },
];

async function executeAudit(body, entitlement, fetcher) {
  const options = {
    bidDate: body.bid_date || new Date().toISOString().slice(0, 10),
    expectedPurchaser: body.expected_purchaser || "",
    expectedBidder: body.expected_bidder || "",
    expectedProjectName: body.expected_project_name || "",
    rubricItems: body.rubric_items || [],
    isPro: entitlement.isPro,
  };

  let report;
  if (body.docx_url) {
    const bytes = await fetchDocxBytesFromUrl(body.docx_url, fetcher);
    report = await auditDocxBuffer(bytes, options);
  } else if (body.docx_base64) {
    const bytes = decodeBase64Bytes(body.docx_base64);
    if (bytes.byteLength > MAX_DOCX_BYTES) {
      throw new Error("Base64 标书超过 15MB 限制。");
    }
    report = await auditDocxBuffer(bytes, options);
  } else if (body.tender_text) {
    report = auditPlainText(body.tender_text, options);
  } else {
    throw new Error("请至少提供 `docx_url`（.docx 下载链接）、`docx_base64` 或 `tender_text`（标书正文文本）之一。");
  }

  const checklist = report.isPro ? exportClearanceChecklist(report) : null;
  return {
    ok: true,
    tier: report.isPro ? "pro" : "free_preview",
    privacyNotice: "纯内存即时解析，标书原文零落盘、零日志留存。",
    report,
    clearanceChecklistMarkdown: checklist?.allowed ? checklist.markdown : null,
    upgradePrompt: null,
    customServiceContact: "政企/招投标代理机构私有化审查规则定制请联系数创引擎工作室：3152557994@qq.com（微信/QQ：3152557994）",
  };
}

export default {
  async fetch(request, env = {}) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const { pathname, origin } = url;

    if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
      return jsonRes({
        ok: true,
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        endpoints: {
          openapi: `${origin}/openapi.json`,
          auditDocx: `${origin}/api/v1/audit-docx`,
          rubricCheck: `${origin}/api/v1/rubric-check`,
          mcp: `${origin}/mcp`,
        },
        offlineWebApp: "https://a3152557994-ship-it.github.io/bid-docx-checker/",
      });
    }

    if (request.method === "GET" && pathname === "/openapi.json") {
      return jsonRes(buildBidGuardOpenApi(origin));
    }

    if (request.method === "POST" && pathname === "/api/v1/audit-docx") {
      try {
        const body = await request.json();
        const entitlement = await resolveProEntitlement(request, body, env);
        const result = await executeAudit(body, entitlement, globalThis.fetch);
        return jsonRes(result, 200);
      } catch (err) {
        return jsonRes({ ok: false, error: err?.message || String(err) }, 400);
      }
    }

    if (request.method === "POST" && pathname === "/api/v1/rubric-check") {
      try {
        const body = await request.json();
        const entitlement = await resolveProEntitlement(request, body, env);
        const result = await executeAudit(body, entitlement, globalThis.fetch);
        return jsonRes({
          ok: true,
          tier: result.tier,
          rubricAudit: result.report.rubricAudit || { totalClauses: 0, results: [] },
        });
      } catch (err) {
        return jsonRes({ ok: false, error: err?.message || String(err) }, 400);
      }
    }

    if (pathname === "/mcp") {
      if (request.method === "GET") {
        return jsonRes({
          name: SERVICE_NAME,
          version: SERVICE_VERSION,
          transport: "streamable-http",
          endpoint: `${origin}/mcp`,
          tools: BIDGUARD_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }
      if (request.method === "POST") {
        let msg;
        try {
          msg = await request.json();
        } catch {
          return jsonRes({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
        }
        if (!("id" in msg)) return new Response(null, { status: 202, headers: CORS_HEADERS });
        const { id, method, params = {} } = msg;

        if (method === "initialize") {
          return jsonRes({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: params?.protocolVersion || "2025-03-26",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
            },
          });
        }
        if (method === "ping") return jsonRes({ jsonrpc: "2.0", id, result: {} });
        if (method === "tools/list") return jsonRes({ jsonrpc: "2.0", id, result: { tools: BIDGUARD_MCP_TOOLS } });
        if (method === "tools/call" && params?.name === "audit_bid_document") {
          try {
            const args = params.arguments || {};
            const entitlement = await resolveProEntitlement(request, args, env);
            const result = await executeAudit(args, entitlement, globalThis.fetch);
            return jsonRes({
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                isError: false,
              },
            });
          } catch (err) {
            return jsonRes({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: `Error: ${err?.message || err}` }], isError: true },
            });
          }
        }
        return jsonRes({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
      }
    }

    return jsonRes({ ok: false, error: "Not Found" }, 404);
  },
};
