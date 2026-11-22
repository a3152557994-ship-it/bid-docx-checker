# 标书排雷王 BidGuard Pro v2.0 (`bid-docx-checker`)

**招投标 Word (`.docx`) 废标项与招标文件 `★` 实质性条款交叉核验器 — 零第三方库纯标准 JS 解析 `.docx` ZIP 二进制流与 XML，支持 100% 纯本地离线浏览器验标 + 云端 OpenAPI / MCP 插件直连（扣子 Coze & 支付宝百宝箱 Tbox）。**

- **在线离线可用官网**: [https://a3152557994-ship-it.github.io/bid-docx-checker/](https://a3152557994-ship-it.github.io/bid-docx-checker/)
- **扣子 / 支付宝百宝箱 OpenAPI 接口**: `https://bidguard-pro-api.a3152557994.workers.dev/openapi.json`
- **远程 Streamable HTTP MCP 入口**: `https://bidguard-pro-api.a3152557994.workers.dev/mcp`
- **AI 索引 (`llms.txt`)**: [https://a3152557994-ship-it.github.io/bid-docx-checker/llms.txt](https://a3152557994-ship-it.github.io/bid-docx-checker/llms.txt)

## 核心技术亮点（v2.0 升级至 7 大一票否决雷区）

- **零外部库二进制 `.docx` 解包**：直接读取 PKZIP 中央目录 (`0x06054b50` / `0x02014b50` / `0x04034b50`)，浏览器端通过原生 `DecompressionStream('deflate-raw')`、Node 与 Cloudflare Worker 端零重依赖秒级解压 `word/document.xml`、`word/header*.xml`、`word/footer*.xml`。离线网页版断网可用，标书底价绝不出本机；插件版支持直接传入扣子/百宝箱上传的 `.docx` 临时链接。
- **七大一票否决废标雷区交叉核验**：
  1. **人民币大小写金额精确分位比对**：将 `壹佰贰拾捌万元整` 精确换算至“分”并与同句/同表小写 `¥1,208,000.00` 比对差额；
  2. **页眉/页脚/正文串名残留排查**：自动揪出套用旧标书遗留的异地采购人、其他项目名或外部公司名；
  3. **工期日历天数冲突检测**：同时核对前后章节工期表述（如 `90日历天` vs `60日历天`）与开竣工日期差值；
  4. **未填模板占位符扫描**：捕获 `XXX`、`【待填】`、`____`、`（请填写）`、`202X年`；
  5. **法定签章与授权委托书锚点完整性检查**；
  6. **企业资质与体系证书过期预警**；
  7. **【v2.0 新增】招标文件 `★` 实质性条款与评分点响应核验 (`auditRubricCompliance`)**：把招标文件里的星号条款 / 评分细则逐条拆解，与投标文件全文交叉比对响应覆盖率，精准标出漏项与负偏离风险。

## 本地运行单测

```bash
npm test
```

## 渠道与授权说明

- **离线网页 Pro（`¥29 单次救急 / ¥99 永久买断`）**：免费展示全部雷区计数与前 2 处精确原句定位；输入 `OPC1.` 离线激活码（WebCrypto Ed25519 验签）解锁全部废标段落原句与《开标前逐项清零核对单》。
- **扣子 Coze / 支付宝百宝箱智能体（`¥9.9 单次救急 / ¥39.9 月卡`）**：见 `release/coze-pack/` 与 `release/alipay-tbox-pack/` 一键导入配置包。
- **联系发码 / 商业合作**：`3152557994@qq.com` / `a3152557994@gmail.com`。
