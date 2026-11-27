import {
  DEFAULT_SAMPLE_META,
  buildSampleTrapDocxBuffer,
  auditDocxBuffer,
  exportClearanceChecklist,
} from "./docx-auditor.js";

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
};

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function runAudit() {
  if (!state.currentBytes) return;

  try {
    const report = await auditDocxBuffer(state.currentBytes, {
      bidDate: els.bidDate.value,
      expectedPurchaser: els.expectedPurchaser.value,
      expectedBidder: els.expectedBidder.value,
      expectedProjectName: els.expectedProjectName.value,
      isPro: true,
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

  els.reportContainer.innerHTML = `
    <section class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;">
        <div>
          <h2 style="margin:0;font-size:1.25rem;">
            📋 标书交叉核验报告（全量免费解锁）：<span style="color:${report.totalIssueCount > 0 ? "#dc2626" : "#059669"};">
              共检出 ${report.totalIssueCount} 处废标隐患（致命项 ${report.fatalCount} 处）
            </span>
          </h2>
          <div style="font-size:0.82rem;color:#475569;margin-top:0.2rem;">
            文件：<code>${escapeHtml(state.currentFileName)}</code> · 已离线解压扫描部件：<code>${escapeHtml(report.scannedXmlParts.join(", "))}</code>（共 ${report.segmentCount} 处文本块）
          </div>
        </div>
        <button type="button" class="btn btn-primary" id="exportChecklistBtn">
          ⬇️ 免费导出《开标前逐项清零核对单》(.md)
        </button>
      </div>

      <div class="minefield-grid">${mineCardsHtml}</div>
      ${issuesHtml}
    </section>
  `;

  document.getElementById("exportChecklistBtn")?.addEventListener("click", () => {
    const exported = exportClearanceChecklist(report);
    if (!exported.allowed) return;
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
  els.fileStatusBadge.textContent = `已加载真实二进制 ZIP/XML 示例标书（${(bytes.byteLength / 1024).toFixed(1)} KB，断网内存解压 · 全量免费解锁）`;
  await runAudit();
}

async function handleUserFile(file) {
  if (!file) return;
  const ab = await file.arrayBuffer();
  state.currentBytes = new Uint8Array(ab);
  state.currentFileName = file.name;
  els.fileStatusBadge.textContent = `本地读取成功：${file.name}（${(ab.byteLength / 1024).toFixed(1)} KB · 零网络上传 · 全量免费解锁）`;
  await runAudit();
}

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

document.getElementById("copyBidMailBtn")?.addEventListener("click", async (e) => {
  await navigator.clipboard.writeText("3152557994@qq.com");
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = "✅ 已复制邮箱: 3152557994@qq.com";
  setTimeout(() => (btn.textContent = old), 1600);
});

document.getElementById("copyBidQqBtn")?.addEventListener("click", async (e) => {
  await navigator.clipboard.writeText("3152557994");
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = "✅ 已复制微信/QQ: 3152557994";
  setTimeout(() => (btn.textContent = old), 1600);
});

loadBuiltinSample();
