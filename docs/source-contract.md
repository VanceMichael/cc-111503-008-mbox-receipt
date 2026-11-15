# 授权原件领取

source.index列出archiveId、revision、etag、totalSize、entries(id,start,end,sha256)，start含端点、end不含端点，摘要针对原件原始字节。只可请求授权区间集合的子集，不能跨空隙；body请求预算为2次，每次最多4个Range。必须带If-Match。服务端可以重排HTTP部分并合并相邻请求范围，各部分Content-Range声明实际闭区间和整个包大小；允许部分重叠但重叠字节须一致。multipart的boundary以HTTP头给出，网络分块不对应部分，数据中的非合法分界字节不能截断内容。ETag变化、200整包、未知范围或包大小不符不能正式接纳。完整且摘要通过的原件允许在部分缺失时保留，result.status为incomplete；补领只请求尚无可信覆盖的授权区间。当前原件是RFC邮件字节，但不要求会话构图、MIME提取或整个mbox解析。

## 收件器接口

保留现有preview，新增src/intake.mjs的collect(source,store)。返回status、records、pending、diagnostics；每条record的id对应授权entry，sha256针对原始原件字节。来源原文和授权索引须在Inbox中保留证据。公开输出示例见acceptance/collection.test.mjs，内部规划与范围账本设计由实现者决定。source.bytes仅供旧版不受限整包预览，授权领取不得直接读取它，必须使用受限HTTP来源。

仅请求一个Range时来源返回普通206和Content-Range；多Range返回multipart，可以合并相邻区间。单部分与多部分的覆盖和授权判定一致，不能把HTTP报文边界等同原件边界。
