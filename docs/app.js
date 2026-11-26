import {
  DEFAULT_SAMPLE_META,
  buildSampleTrapDocxBuffer,
  auditDocxBuffer,
  exportClearanceChecklist,
  verifyLicenseToken,
} from "./docx-auditor.js";

const STORAGE_KEY = "opc_license_bid_docx_checker_v1";

let activeLicenseToken = "";

const state = {
  currentBytes: null,
  currentFileName: "",
  lastReport: null,
};

const els = {
  dropzone: document.getElementById("dropzone"),
  docxInput: document.getElementById("docxInput"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  downloadSampleBtn: document.getElementById("downloadSampleBtn"),
  expectedPurchaser: document.getElementById("expectedPurchaser"),
  expectedBidder: document.getElementById("expectedBidder"),
  expectedProjectName: document.getElementById("expectedProjectName"),
  bidDate: document.getElementById("bidDate"),
  reAuditBtn: document.getElementById("reAuditBtn"),
  fileStatusBadge: document.getElementById("fileStatusBadge"),
  reportContainer: document.getElementById("reportContainer"),
  licenseInput: document.getElementById("licenseInput"),
  activateBtn: document.getElementById("activateBtn"),
  licenseStatus: document.getElementById("licenseStatus"),
  proTopPill: document.getElementById("proTopPill"),
};

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function isCryptographicallyUnlocked() {
  if (!activeLicenseToken) return false;
  const check = await verifyLicenseToken(activeLicenseToken);
  return Boolean(check.valid);
}

async function runAudit() {
  if (!state.currentBytes) return;

  try {
    const verifiedPro = await isCryptographicallyUnlocked();
    const report = await auditDocxBuffer(state.currentBytes, {
      bidDate: els.bidDate.value,
      expectedPurchaser: els.expectedPurchaser.value,
      expectedBidder: els.expectedBidder.value,
      expectedProjectName: els.expectedProjectName.value,
      isPro: verifiedPro,
    });
    state.lastReport = report;
    renderReport(report);
  } catch (err) {
    els.reportContainer.innerHTML = `
      <div class="card" style="border-color:#fca5a5;background:#fef2f2;color:#991b1b;">
        <strong>❌ 解析失败：</strong> ${escapeHtml(err instanceof Error ? err.message : String(err))}
      </div>
    `;
  }
}

function renderReport(report) {
  const mineCardsHtml = report.summaryByCategory
    .map(
      (c) => `
      <div class="mine-card ${c.status}">
        <div style="display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:0.9rem;">
          <span>${c.icon} ${c.code} · ${escapeHtml(c.zhLabel)}</span>
          <span style="color:${c.count > 0 ? "#dc2626" : "#059669"};">
            ${c.count > 0 ? `⚠️ ${c.count} 处` : "✅ 清零"}
          </span>
        </div>
      </div>
    `
    )
    .join("");

  const issuesHtml =
    report.visibleIssues.length === 0
      ? `
      <div style="padding:1.4rem;border-radius:12px;background:#ecfdf5;border:1px solid #10b981;color:#065f46;font-weight:700;">
        🎉 恭喜！当前标书未检出六大常规废标隐患（已扫描 ${report.scannedXmlParts.join(", ")} 共 ${report.segmentCount} 个段落/表格行）。
      </div>
    `
      : report.visibleIssues
          .map(
            (item, idx) => `
          <div class="issue-card">
            <div style="margin-bottom:0.4rem;">
              <span class="issue-loc">📍 ${escapeHtml(item.location)}</span>
              <strong style="font-size:0.98rem;color:#991b1b;">
                #${idx + 1} [${escapeHtml(item.code)}] ${escapeHtml(item.title)}
              </strong>
            </div>
            <div class="excerpt-box"><strong>标书原句：</strong>${escapeHtml(item.excerpt)}</div>
            <div style="font-size:0.88rem;color:#334155;margin-bottom:0.35rem;">
              <strong>🔍 废标判定依据：</strong>${escapeHtml(item.detail)}
            </div>
            <div style="font-size:0.86rem;color:#0f766e;font-weight:600;">
              🛠️ 整改建议：${escapeHtml(item.fixAction)}
            </div>
          </div>
        `
          )
          .join("");

  const lockedHtml =
    !report.isPro && report.hiddenCount > 0
      ? `
      <div class="locked-box">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;margin-bottom:0.75rem;">
          <div>
            <strong style="color:#dc2626;font-size:1.03rem;">
              🚨 警告：标书内另有 ${report.hiddenCount} 处高危废标雷区已被检出（免费版仅展示前 2 处精确定位）
            </strong>
            <div style="font-size:0.83rem;color:#475569;margin-top:0.2rem;">
              一次废标动辄损失数万元投标保证金与差旅费！输入 <code>OPC1.</code> 激活码（<strong>¥19.9 单次 / ¥59 终身买断</strong>）立即查看全部段落原句并导出《开标前逐项清零核对单》。
            </div>
          </div>
          <a href="#proSection" class="btn btn-danger" style="text-decoration:none;">立即解锁全部 ${report.totalIssueCount} 处雷区 →</a>
        </div>
        <div style="display:grid;gap:0.45rem;">
          ${report.lockedCategoriesTeaser
            .map(
              (t) => `
            <div style="display:flex;justify-content:space-between;padding:0.5rem 0.75rem;background:#fff;border:1px solid #fecaca;border-radius:8px;font-size:0.84rem;">
              <span><strong>🔒 隐藏风险 #${Number(t.index)}</strong> · ${escapeHtml(t.label || "高危废标项（已脱敏锁定）")}</span>
              <span style="color:#94a3b8;">解锁 Pro 查看精确位置与原文</span>
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `
      : "";

  els.reportContainer.innerHTML = `
    <section class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;">
        <div>
          <h2 style="margin:0;font-size:1.25rem;">
            📋 标书交叉核验报告：<span style="color:${report.totalIssueCount > 0 ? "#dc2626" : "#059669"};">
              共检出 ${report.totalIssueCount} 处废标隐患（致命项 ${report.fatalCount} 处）
            </span>
          </h2>
          <div style="font-size:0.82rem;color:#475569;margin-top:0.2rem;">
            文件：<code>${escapeHtml(state.currentFileName)}</code> · 已离线解压扫描部件：<code>${escapeHtml(report.scannedXmlParts.join(", "))}</code>（共 ${report.segmentCount} 处文本块）
          </div>
        </div>
        <button type="button" class="btn ${report.isPro ? "btn-primary" : ""}" id="exportChecklistBtn">
          ${report.isPro ? "⬇️ 导出《开标前逐项清零核对单》(.md)" : "🔒 导出《开标前逐项清零核对单》(Pro)"}
        </button>
      </div>

      <div class="minefield-grid">${mineCardsHtml}</div>
      ${issuesHtml}
      ${lockedHtml}
    </section>
  `;

  document.getElementById("exportChecklistBtn")?.addEventListener("click", async () => {
    if (!(await isCryptographicallyUnlocked())) {
      document.getElementById("proSection")?.scrollIntoView({ behavior: "smooth" });
      els.licenseInput?.focus();
      return;
    }
    const exported = exportClearanceChecklist(report);
    if (!exported.allowed) {
      document.getElementById("proSection")?.scrollIntoView({ behavior: "smooth" });
      els.licenseInput?.focus();
      return;
    }
    const blob = new Blob([exported.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exported.filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}

async function loadBuiltinSample() {
  els.expectedPurchaser.value = DEFAULT_SAMPLE_META.expectedPurchaser;
  els.expectedBidder.value = DEFAULT_SAMPLE_META.expectedBidder;
  els.expectedProjectName.value = DEFAULT_SAMPLE_META.expectedProjectName;
  els.bidDate.value = DEFAULT_SAMPLE_META.bidDate;

  const bytes = await buildSampleTrapDocxBuffer();
  state.currentBytes = bytes;
  state.currentFileName = "示例标书-2026智慧园区安防采购投标文件(含6处隐蔽废标坑).docx";
  els.fileStatusBadge.textContent = `已加载真实二进制 ZIP/XML 示例标书（${(bytes.byteLength / 1024).toFixed(1)} KB，断网内存解压）`;
  await runAudit();
}

async function handleUserFile(file) {
  if (!file) return;
  const ab = await file.arrayBuffer();
  state.currentBytes = new Uint8Array(ab);
  state.currentFileName = file.name;
  els.fileStatusBadge.textContent = `本地读取成功：${file.name}（${(ab.byteLength / 1024).toFixed(1)} KB · 零网络上传）`;
  await runAudit();
}

async function tryActivate(tokenStr, silent = false) {
  const res = await verifyLicenseToken(tokenStr);
  if (res.valid) {
    activeLicenseToken = tokenStr.trim();
    localStorage.setItem(STORAGE_KEY, activeLicenseToken);
    els.proTopPill.textContent = "PRO 已激活 · 无限本地排雷";
    els.proTopPill.style.background = "#10b981";
    els.licenseStatus.style.color = "#6ee7b7";
    els.licenseStatus.textContent = `✅ 激活成功（${res.payload.e || res.payload.plan || "bid-docx-checker"}）！已解锁全部废标段落原句与《开标前逐项清零核对单》导出。`;
    await runAudit();
  } else {
    activeLicenseToken = "";
    if (!silent) {
      els.licenseStatus.style.color = "#fca5a5";
      els.licenseStatus.textContent = `❌ 激活码无效：${res.message || res.reason}`;
    }
  }
}

// Drag and drop events
els.dropzone.addEventListener("click", () => els.docxInput.click());
els.dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropzone.classList.add("dragover");
});
els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragover"));
els.dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  els.dropzone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) await handleUserFile(file);
});

els.docxInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) await handleUserFile(file);
});

els.loadSampleBtn.addEventListener("click", () => loadBuiltinSample());

els.downloadSampleBtn.addEventListener("click", async () => {
  const bytes = await buildSampleTrapDocxBuffer();
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sample-trap-bid.docx";
  a.click();
  URL.revokeObjectURL(url);
});

els.reAuditBtn.addEventListener("click", () => runAudit());
els.activateBtn.addEventListener("click", () => tryActivate(els.licenseInput.value, false));

document.getElementById("copyBidOrderBtn")?.addEventListener("click", async (e) => {
  const sel = document.querySelector('input[name="bidPlan"]:checked');
  const planLabel = sel?.value === "single" ? "¥19.9 单次救急卡 (7天复核)" : "¥59 终身买断版";
  const txt = `[标书排雷王订单口令] 选购：${planLabel} (bid-docx-checker) ｜ 联系客服 QQ/邮箱：3152557994@qq.com`;
  await navigator.clipboard.writeText(txt);
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = "✅ 已复制订单口令！";
  setTimeout(() => (btn.textContent = old), 1600);
});

document.getElementById("copyBidQqBtn")?.addEventListener("click", async (e) => {
  await navigator.clipboard.writeText("3152557994");
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = "✅ 已复制 QQ: 3152557994";
  setTimeout(() => (btn.textContent = old), 1600);
});

const savedToken = localStorage.getItem(STORAGE_KEY);
if (savedToken) {
  els.licenseInput.value = savedToken;
  tryActivate(savedToken, true);
}

// Auto-boot with realistic binary .docx trap sample so visitors see instant proof
loadBuiltinSample();
