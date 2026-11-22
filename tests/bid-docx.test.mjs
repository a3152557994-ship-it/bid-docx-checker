import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_SPKI_BASE64,
  PRODUCT_SLUG,
  DEFAULT_SAMPLE_META,
  crc32,
  parseChineseRmbToCents,
  parseNumericRmbToCents,
  buildSampleTrapDocxBuffer,
  auditDocxBuffer,
  exportClearanceChecklist,
  verifyLicenseToken,
} from "../src/docx-auditor.mjs";
import * as browserAuditor from "../docs/docx-auditor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signTestToken(payloadObj, privateKey) {
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payloadObj), "utf8"));
  const sig = crypto.sign(null, Buffer.from(`OPC1.${payloadB64}`, "utf8"), privateKey);
  return `OPC1.${payloadB64}.${toBase64Url(sig)}`;
}

/**
 * Construct a real binary PKZIP (.docx) stream using pure Node `zlib.deflateRawSync`.
 */
function buildDocxWithZlibDeflateRaw(filesObj) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let count = 0;

  for (const [entryName, xmlContent] of Object.entries(filesObj)) {
    const nameBuf = Buffer.from(entryName, "utf8");
    const rawBuf = Buffer.from(xmlContent, "utf8");
    const deflatedBuf = zlib.deflateRawSync(rawBuf);
    const sum = crc32(rawBuf);

    const localHdr = Buffer.alloc(30 + nameBuf.length);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(8, 8); // Method 8: deflate-raw
    localHdr.writeUInt32LE(sum, 14);
    localHdr.writeUInt32LE(deflatedBuf.length, 18);
    localHdr.writeUInt32LE(rawBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);
    nameBuf.copy(localHdr, 30);

    const centralHdr = Buffer.alloc(46 + nameBuf.length);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(8, 10);
    centralHdr.writeUInt32LE(sum, 16);
    centralHdr.writeUInt32LE(deflatedBuf.length, 20);
    centralHdr.writeUInt32LE(rawBuf.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHdr, 46);

    localParts.push(localHdr, deflatedBuf);
    centralParts.push(centralHdr);
    offset += localHdr.length + deflatedBuf.length;
    count += 1;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

test("src/docx-auditor.mjs and docs/docx-auditor.js are byte-identical", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "docx-auditor.mjs"), "utf8");
  const docs = fs.readFileSync(path.join(ROOT, "docs", "docx-auditor.js"), "utf8");
  assert.equal(src, docs);
  assert.equal(browserAuditor.PUBLIC_SPKI_BASE64, PUBLIC_SPKI_BASE64);
  assert.equal(PRODUCT_SLUG, "bid-docx-checker");
});

test("Chinese RMB uppercase to cents and numeric currency conversion pass positive and edge cases", () => {
  assert.equal(parseChineseRmbToCents("人民币壹佰贰拾捌万元整"), 128000000);
  assert.equal(parseChineseRmbToCents("壹佰贰拾万零捌仟元整"), 120800000);
  assert.equal(parseChineseRmbToCents("壹亿零伍佰万零捌拾元伍角叁分"), 10500008053);
  assert.equal(parseChineseRmbToCents("叁拾伍万陆仟柒佰捌拾玖元肆角整"), 35678940);
  assert.equal(parseChineseRmbToCents("零元伍角陆分"), 56);
  assert.equal(parseChineseRmbToCents("普通文字无金额"), null);

  assert.equal(parseNumericRmbToCents("¥1,280,000.00"), 128000000);
  assert.equal(parseNumericRmbToCents("小写：￥1,208,000.00元"), 120800000);
  assert.equal(parseNumericRmbToCents("128.50万元"), 128500000);
});

test("Real binary .docx constructed via zlib.deflateRawSync catches all 6 fatal tender minefields", async () => {
  const customDocxBuf = buildDocxWithZlibDeflateRaw({
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>一、投标函</w:t></w:r></w:p>
          <w:p><w:r><w:t>致：深圳市政务服务数据管理局：我方投标总价为人民币大写：叁佰陆拾万元整（小写：¥3,060,000.00）。</w:t></w:r></w:p>
          <w:p><w:r><w:t>我方承诺总工期：90日历天内完工。</w:t></w:r></w:p>
          <w:p><w:r><w:t>施工进度计划：本项目承诺总工期为60日历天（计划开工日期：2027年03月01日，计划竣工日期：2027年04月05日）。</w:t></w:r></w:p>
          <w:p><w:r><w:t>售后维保由广州旧模版信息技术有限公司负责，联系人：XXX，联系电话：____，日期：202X年11月。</w:t></w:r></w:p>
          <w:p><w:r><w:t>电子与智能化专业承包资质证书有效期至2025年12月31日。</w:t></w:r></w:p>
        </w:body>
      </w:document>`,
    "word/header1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:p><w:r><w:t>东莞市智慧交通改造项目投标文件</w:t></w:r></w:p>
      </w:hdr>`,
    "word/footer1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:p><w:r><w:t>第 1 页</w:t></w:r></w:p>
      </w:ftr>`,
  });

  // 1. Verify via standard DecompressionStream('deflate-raw') in Pro mode
  const proReport = await auditDocxBuffer(customDocxBuf, {
    bidDate: "2026-11-17",
    expectedPurchaser: "深圳市政务服务数据管理局",
    expectedBidder: "深圳湾科创系统股份有限公司",
    expectedProjectName: "深圳市政务云安全态势感知采购项目",
    isPro: true,
  });

  assert.equal(proReport.scannedXmlParts.length, 3);
  for (const cat of proReport.summaryByCategory) {
    assert.ok(cat.count >= 1, `Expected minefield ${cat.id} (${cat.zhLabel}) detected, got 0`);
  }

  // 2. Also verify Node zlib.inflateRawSync fallback path yields identical issue count
  const zlibReport = await auditDocxBuffer(customDocxBuf, {
    bidDate: "2026-11-17",
    expectedPurchaser: "深圳市政务服务数据管理局",
    expectedBidder: "深圳湾科创系统股份有限公司",
    expectedProjectName: "深圳市政务云安全态势感知采购项目",
    isPro: false,
    forceNodeZlib: true,
  });
  assert.equal(zlibReport.totalIssueCount, proReport.totalIssueCount);
  assert.equal(zlibReport.visibleIssues.length, 2); // Free preview capped at 2
  assert.equal(zlibReport.hiddenCount, proReport.totalIssueCount - 2);

  // 3. Verify Checklist export gating
  assert.equal(exportClearanceChecklist(zlibReport).allowed, false);
  const checklist = exportClearanceChecklist(proReport);
  assert.equal(checklist.allowed, true);
  assert.match(checklist.markdown, /开标前废标风险逐项清零核对单/);
  assert.match(checklist.markdown, /叁佰陆拾万元整/);
});

test("Clean compliant .docx bid passes with 0 disqualification issues", async () => {
  const cleanDocx = buildDocxWithZlibDeflateRaw({
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>一、投标函</w:t></w:r></w:p>
          <w:p><w:r><w:t>致：杭州滨江智慧园区管理委员会：我方投标总价为人民币壹佰贰拾捌万元整（小写：¥1,280,000.00），总工期 90 日历天。</w:t></w:r></w:p>
          <w:p><w:r><w:t>二、开标一览表</w:t></w:r></w:p>
          <w:p><w:r><w:t>三、法定代表人授权委托书</w:t></w:r></w:p>
          <w:p><w:r><w:t>安全生产许可证有效期至2028年12月31日。实施工期：90日历天。</w:t></w:r></w:p>
          <w:p><w:r><w:t>投标人（盖章）：浙江数智安防科技有限公司  法定代表人或委托代理人（签字）：王明</w:t></w:r></w:p>
        </w:body>
      </w:document>`,
    "word/header1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:p><w:r><w:t>2026年杭州滨江智慧园区安防升级采购项目</w:t></w:r></w:p>
      </w:hdr>`,
  });

  const report = await auditDocxBuffer(cleanDocx, {
    ...DEFAULT_SAMPLE_META,
    isPro: true,
  });

  assert.equal(report.totalIssueCount, 0, `Expected 0 issues on clean bid, got: ${JSON.stringify(report.allIssues)}`);
  assert.equal(report.safetyScore, 100);
});

test("Built-in sample .docx generator produces valid archive triggering all 6 minefields", async () => {
  const sampleBytes = await buildSampleTrapDocxBuffer();
  assert.ok(sampleBytes.byteLength > 500);
  const report = await auditDocxBuffer(sampleBytes, {
    ...DEFAULT_SAMPLE_META,
    isPro: true,
  });
  assert.equal(report.summaryByCategory.every((c) => c.count >= 1), true);
});

test("Ed25519 OPC1 license verification works for bid-docx-checker and wildcard *", async () => {
  const bad = await verifyLicenseToken("OPC1.eyJ2IjoxLCJwIjoiYmlkLWRvY3gtY2hlY2tlciJ9.AAAA");
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, "BAD_SIGNATURE");

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const testSpkiB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const nowSec = Math.floor(Date.now() / 1000);

  const okToken = signTestToken({ v: 1, p: "bid-docx-checker", plan: "lifetime", exp: 0 }, privateKey);
  const starToken = signTestToken({ v: 1, p: "*", plan: "all", exp: 0 }, privateKey);
  const wrongToken = signTestToken({ v: 1, p: "shopify-faq-geo", exp: 0 }, privateKey);

  assert.equal((await verifyLicenseToken(okToken, { publicSpkiBase64: testSpkiB64, nowSec })).valid, true);
  assert.equal((await verifyLicenseToken(starToken, { publicSpkiBase64: testSpkiB64, nowSec })).valid, true);
  assert.equal((await verifyLicenseToken(wrongToken, { publicSpkiBase64: testSpkiB64, nowSec })).reason, "PRODUCT_MISMATCH");

  for (const rel of ["docs/index.html", "docs/llms.txt", "docs/robots.txt", "docs/sitemap.xml", "README.md"]) {
    const txt = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.equal(txt.includes("/Users/"), false, `Unexpected local path leak in ${rel}`);
  }
});

test("M7 rubric compliance & plain text auditor detect mandatory ★ misses and matched evidence", async () => {
  const { auditPlainText } = await import("../src/docx-auditor.mjs");
  const sampleText = [
    "页眉：宁波市鄞州区政务云扩容项目投标文件",
    "一、投标函",
    "致：杭州滨江智慧园区管理委员会：投标总价人民币大写：壹佰贰拾捌万元整（小写：¥1,208,000.00）。",
    "商务承诺：提供 7×24 小时驻场响应，免费质保期 3 年，并附 ISO27001 体系认证证书。",
    "投标人（盖章）：浙江数智安防科技有限公司  法定代表人签字：王明",
  ].join("\n");

  const report = auditPlainText(sampleText, {
    ...DEFAULT_SAMPLE_META,
    isPro: true,
    rubricItems: [
      "★ 必须提供 7×24 小时驻场响应及 3 年免费质保",
      "★ 必须提供近三年类似安防业绩合同及项目经理社保证明",
    ],
  });

  assert.ok(report.totalIssueCount >= 2); // M1 mismatch + M2 header leak + M5 missing auth
  assert.equal(report.rubricAudit.totalClauses, 2);
  assert.equal(report.rubricAudit.matchedCount, 1);
  assert.equal(report.rubricAudit.fatalMissingCount, 1);
  const checklist = exportClearanceChecklist(report);
  assert.match(checklist.markdown, /招标实质性条款（★）/);
});

test("BidGuard Cloudflare Worker API + MCP + SSRF protection + Coze/Alipay paywall unlock", async () => {
  const workerMod = await import("../worker/index.mjs");
  const worker = workerMod.default;
  const sampleBytes = await buildSampleTrapDocxBuffer();
  const sampleB64 = Buffer.from(sampleBytes).toString("base64");

  // 1. OpenAPI schema endpoint
  const oaRes = await worker.fetch(new Request("https://bidguard.example.workers.dev/openapi.json"), {});
  assert.equal(oaRes.status, 200);
  const oaJson = await oaRes.json();
  assert.equal(oaJson.openapi, "3.0.1");
  assert.ok(oaJson.paths["/api/v1/audit-docx"]);

  // 2. Free preview on Base64 .docx caps visibleIssues at 2 and reports hiddenCount > 0
  const freeRes = await worker.fetch(
    new Request("https://bidguard.example.workers.dev/api/v1/audit-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docx_base64: sampleB64,
        bid_date: DEFAULT_SAMPLE_META.bidDate,
        expected_purchaser: DEFAULT_SAMPLE_META.expectedPurchaser,
        expected_bidder: DEFAULT_SAMPLE_META.expectedBidder,
        expected_project_name: DEFAULT_SAMPLE_META.expectedProjectName,
      }),
    }),
    {},
  );
  assert.equal(freeRes.status, 200);
  const freeJson = await freeRes.json();
  assert.equal(freeJson.tier, "free_preview");
  assert.equal(freeJson.report.visibleIssues.length, 2);
  assert.ok(freeJson.report.hiddenCount > 0);
  assert.equal(freeJson.clearanceChecklistMarkdown, null);

  // 3. Trusted Coze/Alipay workflow header unlocks Pro checklist
  const paidRes = await worker.fetch(
    new Request("https://bidguard.example.workers.dev/api/v1/audit-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plugin-Secret": "sec_coze_123" },
      body: JSON.stringify({
        docx_base64: sampleB64,
        bid_date: DEFAULT_SAMPLE_META.bidDate,
        expected_purchaser: DEFAULT_SAMPLE_META.expectedPurchaser,
        expected_bidder: DEFAULT_SAMPLE_META.expectedBidder,
        expected_project_name: DEFAULT_SAMPLE_META.expectedProjectName,
        paid_order_verified: true,
      }),
    }),
    { PLUGIN_SHARED_SECRET: "sec_coze_123" },
  );
  const paidJson = await paidRes.json();
  assert.equal(paidJson.tier, "pro");
  assert.match(paidJson.clearanceChecklistMarkdown, /开标前废标风险逐项清零核对单/);

  // 4. SSRF protection blocks localhost/internal docx_url
  const ssrfRes = await worker.fetch(
    new Request("https://bidguard.example.workers.dev/api/v1/audit-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docx_url: "http://127.0.0.1:8080/secret.docx" }),
    }),
    {},
  );
  assert.equal(ssrfRes.status, 400);

  // 5. MCP Streamable HTTP tools/list + tools/call
  const mcpRes = await worker.fetch(
    new Request("https://bidguard.example.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    {},
  );
  const mcpJson = await mcpRes.json();
  assert.equal(mcpJson.result.tools[0].name, "audit_bid_document");
  assert.equal(mcpJson.result.tools[0].annotations.readOnlyHint, true);
});

test("Standalone zero-API-key Coze code node (coze-code-node.js) executes cleanly", async () => {
  const { main } = await import("../release/coze-pack/coze-code-node.js");
  const out = await main({
    params: {
      tender_text:
        "一、投标函\n人民币大写：壹佰贰拾捌万元整（小写：¥1,208,000.00）\n总工期90日历天\n施工进度总工期60日历天\n联系人：XXX\n安全生产许可证有效期至2025年12月31日。",
      bid_date: "2026-11-22",
      rubric_text: "★ 必须提供 7×24 驻场服务\n★ 提供近三年业绩合同",
      is_pro: false,
    },
  });
  assert.ok(out.total_issue_count >= 4);
  assert.equal(out.visible_issues.length, 2);
  assert.ok(out.hidden_count >= 2);
  assert.equal(out.rubric_missing_count, 2);
  assert.match(out.paywall_hint, /解锁 Pro/);
});
