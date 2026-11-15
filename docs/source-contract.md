# 来源接口与资料语义

接收的mboxrd包使用LF；envelope行须行首From加发送者和ctime时间，完整行才构成分隔。每个正文行若匹配^>+From 则移除恰好一个>，头部不做该还原。包配套receipt.json声明archiveId、revision、byteLength、sha256、sealed；仅长度摘要都匹配且sealed=true时尾信完整。前一信由下一个完整envelope界定，包尾开放信可保留为pending。Content-Length不参与分隔，Message-ID只作声明字段。保留encapsulated字节范围、还原后的RFC字节摘要及每包出现顺序，不改写嵌套MIME或邮件换行。

## 收件器扩展接口

现有 `src/intake.mjs` 导出 `preview(source, store)`，只做预览。收件器入口为新增的 `collect(source, store)`，由调用方负责创建和关闭来源及 Inbox。`npm run acceptance` 调用这一入口。返回的 `records` 是可正式交付资料，不把未确认片段放进该集合；特殊业务的 pending 和 diagnostics 独立返回。原始证据通过 Inbox 保存，正式记录应含证据引用。接口不规定内部架构，允许增加模块和持久表，但不能移除原预览或更改来源语义。

## 可观察边界

- 正文From、>From及>>From还原层次
- Message-ID重号与缺号
- 跨chunk的envelope和UTF8
- 未sealed包的尾信暂存
- 重排修订包保留相同原件的两次出现

## 公开的结果字段

`acceptance/collection.test.mjs` 给出当前集成方使用的结果字段及最小示例，说明的是输出契约而非内部处理步骤。除这些示例外，以上来源语义也属于功能范围，不能靠场景名称分支返回固定答案。`status` 仅在对应资料闭合且可靠取得时为 complete。
