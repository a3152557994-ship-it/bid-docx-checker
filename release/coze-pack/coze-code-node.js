/**
 * 标书排雷王 BidGuard — 扣子（Coze 国内版）内置代码节点【零 API Key · 零外部服务器 · 永不失效版】
 *
 * 适用场景：
 *   1. 直接粘贴到 Coze 工作流的「代码节点（JavaScript）」中运行，无需买任何第三方 API Key，无需部署服务器！
 *   2. 输入参数 params：
 *      - tender_text: string（必填，由扣子「文档读取/OCR节点」或用户直接粘贴的标书文本）
 *      - bid_date: string（可选，开标日期如 "2026-11-30"）
 *      - expected_purchaser: string（可选，本次正确招标人/采购人全称）
 *      - expected_bidder: string（可选，本次投标人公司全称）
 *      - expected_project_name: string（可选，本次正确项目名称）
 *      - rubric_text: string（可选，招标文件 ★ 实质性条款/评分细则，每行一条）
 *      - is_pro: boolean（可选，是否已付款解锁全量明细；false 时展示前 2 处精确定位与剩余隐藏致命雷区预告）
 */

const CN_DIGITS = {
  零: 0, 〇: 0, 壹: 1, 一: 1, 贰: 2, 貳: 2, 二: 2, 两: 2,
  叁: 3, 參: 3, 三: 3, 肆: 4, 四: 4, 伍: 5, 五: 5,
  陆: 6, 陸: 6, 六: 6, 柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9,
};
const CN_SMALL = { 拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000 };
const CN_SEC = { 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000 };

function parseCnInt(s) {
  let total = 0, sec = 0, cur = 0, hit = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) { cur = CN_DIGITS[ch]; hit = true; }
    else if (ch in CN_SMALL) {
      const m = cur === 0 && (ch === "拾" || ch === "十") && sec === 0 ? 1 : cur;
      sec += m * CN_SMALL[ch]; cur = 0; hit = true;
    } else if (ch in CN_SEC) {
      sec += cur; cur = 0;
      if (CN_SEC[ch] === 100000000) { total = (total + sec) * 100000000; sec = 0; }
      else { total += sec * CN_SEC[ch]; sec = 0; }
      hit = true;
    }
  }
  return hit ? total + sec + cur : null;
}

function parseCnRmbToCents(raw) {
  const c = String(raw || "").replace(/^(?:人民币|大写金额|大写|合计大写|总价大写|报价大写|[：:\s])+/, "").replace(/\s+/g, "");
  if (!c || !/[零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億]/.test(c) || !/[圆元角分]/.test(c)) return null;
  let yuan = 0, jiao = 0, fen = 0, frac = c;
  const sp = c.match(/^(.*?)[圆元](.*)$/);
  if (sp) {
    if (sp[1]) {
      const pi = parseCnInt(sp[1]);
      if (pi === null) return null;
      yuan = pi;
    }
    frac = sp[2] || "";
  }
  frac = frac.replace(/[整正]/g, "");
  const jm = frac.match(/([零〇壹贰貳叁參肆伍陆陸柒捌玖一二三四五六七八九])角/);
  if (jm) jiao = CN_DIGITS[jm[1]] ?? 0;
  const fm = frac.match(/([零〇壹贰貳叁參肆伍陆陸柒捌玖一二三四五六七八九])分/);
  if (fm) fen = CN_DIGITS[fm[1]] ?? 0;
  return Math.round(yuan * 100 + jiao * 10 + fen);
}

function parseNumRmbToCents(raw) {
  const m = String(raw || "").match(/(?:[¥￥]|小写[：:\s]*|RMB\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{1,6}))?\s*(万元|万|元)?/i);
  if (!m) return null;
  const val = parseFloat(`${m[1].replace(/,/g, "")}.${m[2] || "0"}`);
  if (!Number.isFinite(val)) return null;
  return Math.round(val * ((m[3] || "").startsWith("万") ? 1000000 : 100));
}

function fmtYuan(cents) {
  const abs = Math.abs(Math.round(cents));
  const y = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}¥${y}.${String(abs % 100).padStart(2, "0")}`;
}

function parseDateMs(s) {
  const m = String(s || "").match(/(20\d{2})\s*[年./-]\s*(0?[1-9]|1[0-2])\s*[月./-]\s*(0?[1-9]|[12]\d|3[01])\s*日?/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function normOrg(s) {
  return String(s || "").replace(/[（）()\s·.,，。：:]/g, "").trim();
}

export async function main({ params }) {
  const text = String(params?.tender_text || "");
  const bidDate = String(params?.bid_date || new Date().toISOString().slice(0, 10));
  const bidMs = parseDateMs(bidDate) ?? Date.now();
  const expPurchaser = normOrg(params?.expected_purchaser);
  const expBidder = normOrg(params?.expected_bidder);
  const expProject = normOrg(params?.expected_project_name);
  const isPro = Boolean(params?.is_pro);

  const lines = text.replace(/\r\n?/g, "\n").split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const segs = lines.map((t, i) => ({ loc: `第 ${i + 1} 段`, text: t }));
  const issues = [];

  // M1: 人民币大小写精确分位比对
  const upRe = /(?:人民币)?(?:大写[：:\s]*)?([零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億]+[圆元][零〇壹贰貳叁參肆伍陆陸柒捌玖角分整正]*)/g;
  const lowRe = /(?:[¥￥]\s*[0-9][0-9,]*(?:\.[0-9]{1,4})?\s*(?:万元|元)?|小写[：:\s]*[¥￥]?\s*[0-9][0-9,]*(?:\.[0-9]{1,4})?\s*(?:万元|元)?|[0-9][0-9,]{2,}(?:\.[0-9]{1,4})?\s*(?:万元|元))/g;
  const totals = [];
  for (const seg of segs) {
    const ups = [...seg.text.matchAll(upRe)];
    const lows = [...seg.text.matchAll(lowRe)];
    for (let i = 0; i < Math.min(ups.length, lows.length); i += 1) {
      const uc = parseCnRmbToCents(ups[i][1]);
      const lc = parseNumRmbToCents(lows[i][0]);
      if (uc !== null && lc !== null && uc !== lc) {
        issues.push({
          code: "M1", severity: "致命废标", loc: seg.loc,
          title: `大小写金额不符（相差 ${fmtYuan(Math.abs(uc - lc))}）`,
          detail: `大写「${ups[i][1]}」=${fmtYuan(uc)} ≠ 小写「${lows[i][0].trim()}」=${fmtYuan(lc)}`,
          excerpt: seg.text.slice(0, 120),
        });
      } else if (uc !== null && /(总报价|投标总价|报价合计)/.test(seg.text)) {
        totals.push({ cents: uc, loc: seg.loc, raw: ups[i][1] });
      }
    }
  }
  if (totals.length >= 2) {
    for (let i = 1; i < totals.length; i += 1) {
      if (totals[i].cents !== totals[0].cents) {
        issues.push({
          code: "M1", severity: "致命废标", loc: `${totals[0].loc} vs ${totals[i].loc}`,
          title: "前后章节总报价矛盾",
          detail: `${fmtYuan(totals[0].cents)} ≠ ${fmtYuan(totals[i].cents)}`,
          excerpt: `${totals[0].raw} vs ${totals[i].raw}`,
        });
      }
    }
  }

  // M2: 串名残留
  const orgRe = /([\u4e00-\u9fa5]{2,22}(?:有限公司|股份有限公司|集团有限公司|管理局|委员会|财政局|住建局|教育局|卫健委|采购中心|大数据局|大数据发展管理局|政务服务局))/g;
  const projRe = /([\u4e00-\u9fa50-9A-Za-z]{4,30}(?:采购项目|建设项目|扩容项目|改造项目|招标项目))/g;
  for (const seg of segs) {
    if (expProject) {
      for (const pm of seg.text.matchAll(projRe)) {
        const fp = normOrg(pm[1]);
        if (fp && !expProject.includes(fp) && !fp.includes(expProject)) {
          issues.push({ code: "M2", severity: "致命废标", loc: seg.loc, title: `残留旧项目名「${pm[1]}」`, detail: `与目标项目不一致`, excerpt: seg.text.slice(0, 120) });
        }
      }
    }
    if (expPurchaser || expBidder) {
      for (const om of seg.text.matchAll(orgRe)) {
        const rawOrg = om[1].replace(/^(?:致|采购人|招标人|投标人|由|在|向|与)+/, "");
        const n = normOrg(rawOrg);
        if (n.length < 5) continue;
        const okP = expPurchaser && (expPurchaser.includes(n) || n.includes(expPurchaser));
        const okB = expBidder && (expBidder.includes(n) || n.includes(expBidder));
        if (!okP && !okB) {
          issues.push({ code: "M2", severity: "致命废标", loc: seg.loc, title: `疑似串名残留「${rawOrg}」`, detail: "非本次招标人或投标人", excerpt: seg.text.slice(0, 120) });
        }
      }
    }
  }

  // M3: 工期冲突
  const durRe = /(?:总?工期|交货期|服务期|完工期)[^0-9\n。；]{0,10}?(\d{1,4})\s*个?\s*日历[天日]/g;
  const durs = [];
  for (const seg of segs) {
    for (const dm of seg.text.matchAll(durRe)) durs.push({ days: Number(dm[1]), loc: seg.loc });
  }
  if (durs.length >= 2) {
    for (let i = 1; i < durs.length; i += 1) {
      if (durs[i].days !== durs[0].days) {
        issues.push({ code: "M3", severity: "致命废标", loc: `${durs[0].loc} vs ${durs[i].loc}`, title: "前后工期日历天冲突", detail: `${durs[0].days}天 ≠ ${durs[i].days}天`, excerpt: `${durs[0].loc}(${durs[0].days}日历天) vs ${durs[i].loc}(${durs[i].days}日历天)` });
      }
    }
  }

  // M4: 占位符残留
  const phs = [/【\s*(?:待填|请填写|待补充)\s*】/, /[（(]\s*(?:请填写|待填|空白)\s*[)）]/, /_{3,}/, /20[2X]X\s*年/i, /(?:^|[^A-Za-z])(?:XXX|×××)(?:$|[^A-Za-z])/];
  for (const seg of segs) {
    if (phs.some((re) => re.test(seg.text))) {
      issues.push({ code: "M4", severity: "高危", loc: seg.loc, title: "存在未填模板占位符（XXX/____/【待填】/202X）", detail: "形式评审易直接不通过", excerpt: seg.text.slice(0, 120) });
    }
  }

  // M5: 法定锚点
  const full = segs.map((s) => s.text).join("\n");
  const missing = [
    ["《投标函》", /投\s*标\s*函/],
    ["《法定代表人授权委托书》", /法定代表人授权(?:委托)?书|授权委托书/],
    ["《开标/报价一览表》", /(?:开标|报价)一览表/],
    ["单位公章位置", /投标人\s*[（(]?盖\s*章|单位公章|加盖公章/],
    ["法定代表人/授权代表签字位", /(?:法定代表人|委托代理人|授权代表)[^。\n]{0,12}(?:签字|签章)/],
  ].filter(([, re]) => !re.test(full)).map(([name]) => name);
  if (missing.length > 0) {
    issues.push({ code: "M5", severity: "致命废标", loc: "全文结构", title: `缺失 ${missing.length} 处法定章节/签章锚点`, detail: `未检出：${missing.join("、")}`, excerpt: missing.join("；") });
  }

  // M6: 资质过期
  const expRe = /有效期\s*(?:至|截止[至到]?|[：:\s]*20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?\s*(?:至|-|—|~|到)\s*)[：:\s]*(20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)/g;
  for (const seg of segs) {
    for (const em of seg.text.matchAll(expRe)) {
      const ms = parseDateMs(em[1]);
      if (ms !== null && ms < bidMs) {
        issues.push({ code: "M6", severity: "致命废标", loc: seg.loc, title: `资质证书已于 ${em[1]} 过期`, detail: `早于开标日 ${bidDate}`, excerpt: seg.text.slice(0, 120) });
      }
    }
  }

  // M7: ★ 实质性条款/评分点漏项核对
  const rubricLines = String(params?.rubric_text || "").split(/\r?\n|[；;]/).map((s) => s.trim()).filter(Boolean);
  const rubricMissing = [];
  const compactFull = full.replace(/\s+/g, "").toLowerCase();
  for (const clause of rubricLines) {
    const clean = clause.replace(/^[★*▲●•\d.、()（）\s]+/, "");
    const tokens = clean.match(/(?:ISO\s*\d+|\d+(?:\.\d+)?\s*(?:年|个月|日历天|工作日|小时|%|万元|名)|质保|驻场|响应|业绩|社保|许可证|培训|保密)/gi) || [clean.slice(0, 4)];
    const hit = tokens.some((tk) => compactFull.includes(tk.replace(/\s+/g, "").toLowerCase()));
    if (!hit) rubricMissing.push(clause);
  }

  const safetyScore = Math.max(0, 100 - issues.reduce((a, b) => a + (b.severity === "致命废标" ? 18 : 10), 0) - rubricMissing.length * 10);
  const visibleIssues = isPro ? issues : issues.slice(0, 2);
  const hiddenCount = Math.max(0, issues.length - visibleIssues.length);

  return {
    safety_score: safetyScore,
    total_issue_count: issues.length,
    fatal_count: issues.filter((i) => i.severity === "致命废标").length,
    hidden_count: hiddenCount,
    is_pro: isPro,
    visible_issues: visibleIssues,
    rubric_missing_count: rubricMissing.length,
    rubric_missing_items: isPro ? rubricMissing : rubricMissing.slice(0, 1),
    paywall_hint: !isPro && (hiddenCount > 0 || rubricMissing.length > 1)
      ? `免费版已展示前 2 处定位；尚有 ${hiddenCount} 处隐藏废标项与 ${Math.max(0, rubricMissing.length - 1)} 项漏答评分点未展示，解锁 Pro（¥9.9 单次救急 / ¥39.9 月卡）立得完整逐段清单！`
      : "已完成全部排雷核验。",
  };
}
