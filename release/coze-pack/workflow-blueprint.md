# 扣子（Coze 国内版 coze.cn）6 节点可视化工作流 & 商业变现配置蓝图

## 路线选择（双版本适配不同买家）
1. **公域商店收费版（挂扣子商店 + 支付宝支付插件）**：调 Cloudflare Worker 云端 `auditBidDocument` 插件，支持直接上传 `.docx` 穿透**页眉/页脚/报价表格 XML**！
2. **闲鱼卖模板「零 API Key・永不失效版」**：不用外连服务器，直接把同目录下 [coze-code-node.js](./coze-code-node.js) 粘进扣子内置「代码节点（JavaScript）」，搭配扣子内置免费文档读取节点 + 免费云雀/豆包大模型节点——**买家复制后 0 元 API 费、永不因接口过期失效**！

---

## 标准 6 节点工作流编排（Coze Studio）

```text
[1. Start 开始节点]
   输入：bid_file (File .docx) / tender_text (String) / expected_project / expected_purchaser / bid_date / rubric_text / order_id (可选)
      │
      ▼
[2. 数据库/订单状态判断节点（查是否已付 Pro）]
   条件分支：已付（is_pro = true） vs 免费体检（is_pro = false）
      │
      ├──► 若走云端插件版：[3A. 自定义 OpenAPI 插件 `auditBidDocument`]
      │       - 导入 openapi-coze.json（已配置公网 HTTPS 地址）
      │       - 请求头隐式配置 X-Plugin-Secret（禁止暴露给模型！）
      │
      └──► 若走零服务器模板版：[3B. 扣子官方「文档读取」节点] → [代码节点 `coze-code-node.js`]
      │
      ▼
[4. 条件分支（检查 hidden_count > 0 && !is_pro）]
   ├──► 未付费且有隐藏雷区：
   │       调 [支付宝支付插件 `create_mobile_alipay_payment`]
   │       - 业务参数（暴露给模型）：商品标题="标书排雷王完整清零核对单"，金额="9.90"
   │       - 系统参数（关闭暴露，后台写死）：AP_APP_ID / AP_APP_KEY / AP_PUB_KEY（杭州数创引擎支付宝商户号）
   │
   └──► 已付费：直接输出全量明细 + Markdown《开标前逐项清零核对单》
      │
      ▼
[5. 大模型排版输出节点（选用扣子免费内置模型，零第三方 Key）]
   任务：仅负责把确定性引擎的 JSON 结果整理成清晰易读的红黑风险清单，严禁篡改数字与原文！
      │
      ▼
[6. End 结束节点] 返回最终排雷报告 + 支付/下载按钮
```

## 扣子安全红线自检
- `AP_APP_KEY`（支付宝商户私钥）与 `X-Plugin-Secret` **必须关闭「对大模型可见」**，防 Prompt 注入盗取密钥。
- 若用于闲鱼售卖「工作流复制链接」，发货模板务必使用 **3B 零外部服务器代码节点版**，并在宝贝详情注明「零第三方 API Key、永不失效」。
