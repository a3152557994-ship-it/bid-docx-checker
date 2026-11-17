# 标书排雷王 BidGuard (`bid-docx-checker`)

**招投标 Word (`.docx`) 废标项 100% 纯本地离线交叉核验器 — 零第三方库、零服务器上传，纯标准 JS 解析 `.docx` ZIP 二进制流与 XML。**

- **在线离线可用官网**: [https://a3152557994-ship-it.github.io/bid-docx-checker/](https://a3152557994-ship-it.github.io/bid-docx-checker/)
- **AI 索引 (`llms.txt`)**: [https://a3152557994-ship-it.github.io/bid-docx-checker/llms.txt](https://a3152557994-ship-it.github.io/bid-docx-checker/llms.txt)

## 核心技术亮点

- **零外部库二进制 `.docx` 解包**：直接读取 PKZIP 中央目录 (`0x06054b50` / `0x02014b50` / `0x04034b50`)，浏览器端通过原生 `DecompressionStream('deflate-raw')`、Node 端兼容 `zlib.inflateRawSync` 秒级解压 `word/document.xml`、`word/header*.xml`、`word/footer*.xml`。断网可用，标书底价与公章绝不出本机。
- **六大一票否决废标雷区交叉核验**：
  1. **人民币大小写金额精确分位比对**：将 `壹佰贰拾捌万元整` 精确换算至“分”并与同句/同表小写 `¥1,208,000.00` 比对差额；
  2. **页眉/页脚/正文串名残留排查**：自动揪出套用旧标书遗留的异地采购人、其他项目名或外部公司名；
  3. **工期日历天数冲突检测**：同时核对前后章节工期表述（如 `90日历天` vs `60日历天`）与开竣工日期差值；
  4. **未填模板占位符扫描**：捕获 `XXX`、`【待填】`、`____`、`（请填写）`、`202X年`；
  5. **法定签章与授权委托书锚点完整性检查**；
  6. **企业资质与体系证书过期预警**。

## 本地运行单测

```bash
npm test
```

## Pro 授权说明（`¥29 单次救急 / ¥99 永久买断`）

- 免费版展示全部雷区计数与前 2 处精确原句定位；
- 输入 `OPC1.` 离线激活码（本地 WebCrypto Ed25519 验签）解锁全部废标段落原句与一键导出《开标前逐项清零核对单》；
- 联系发码：`3152557994@qq.com` / `a3152557994@gmail.com`。
