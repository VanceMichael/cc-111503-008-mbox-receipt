# 邮箱交接包的授权字节区间与批量领取

Node.js 资料接收项目。保留不受限来源的单次预览，并通过 `src/intake.mjs` 的 `collect(source, store)` 提供按授权索引的正式收件：一次请求可携带多个字节区间，逐部分核对授权覆盖、包版本（ETag/If-Match）、包大小与原件 sha256 后才登记。接收方因此能区分“能打开来源”和“已经可靠取得可交付资料”。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证预览、真实来源交互、收件存储以及收件器的解析、授权与截断处理。`npm run demo` 启动本地来源，执行一次真实预览和一次按授权领取，输出取得的内容、缺口与证据摘要后自动关闭。`npm run acceptance` 检查收件扩展接口（`collect` 的公开输出契约），当前与单元测试一起全部通过。

Linux 环境可用 `docker build -t mbox-receipt:local .` 预装依赖，然后 `docker run --rm --network none mbox-receipt:local` 验证底座。`docker run --rm --network none mbox-receipt:local npm run demo` 展示真实预览。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。收件功能开发后的演示应在同一环境运行收件检查，不靠预设结果文本代替产品执行。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储，preview 本身不会声称已经完成业务接收。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。

## 收件判定

`collect` 的范围账本（`src/coverage-ledger.mjs`）只接受落在授权区间并集内的部分；跨空隙的部分整体拒收，重叠字节必须一致，否则拒收冲突部分。`multipart/byteranges`（`src/multipart.mjs`）只按 HTTP 头声明的 boundary 识别分界，邮件正文中的相似字节不构成部分；每个部分凭自身 `Content-Range` 声明的实际闭区间独立核对，与到达顺序无关，服务端重排或合并相邻区间都不影响配给。普通 200 整包、412 版本冲突、包大小不符、未知范围都不会产生记录；部分缺失或截断时 `status` 为 `incomplete`，`pending` 精确列出每个未闭合原件仍缺的字节区间，补领只请求这些区间且仍受原索引约束。授权索引、每次 HTTP 报文原文和通过摘要的原件均作为 evidence 存入 Inbox，部门交接可逐封回溯到索引条目与实际收到的字节。
