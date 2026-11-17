# 邮箱交接包的授权字节区间与批量领取

Node.js 资料接收项目。来源原件通过受限 HTTP 按授权索引领取：`collect` 只请求授权 entry 的字节区间，按每部分声明的 Content-Range 记账，不依赖 HTTP 部分顺序或报文边界；旧版整包预览仍保留，但与授权收件相互独立。项目的用途是让接收方区分“能打开来源”和“已经可靠取得可交付资料”。

## 运行

运行时固定为 Node.js 22.23.4，npm 依赖由 package-lock.json 固定。准备阶段执行 `npm ci --ignore-scripts --no-audit --no-fund`；依赖准备完成后，运行和测试不联网。只使用本地生成资料和 loopback 来源，不需要生产账号。

`npm test` 验证当前预览、真实来源交互、收件存储以及 multipart 解析与字节账本边界。`npm run demo` 启动本地来源，执行一次真实预览，输出取得的内容和证据摘要后自动关闭。`npm run acceptance` 检查 `src/intake.mjs` 的 `collect` 收件契约（乱序部分、200 整包、ETag 变化、传输截断）。功能交付后，现有测试与收件检查同时通过，没有跳过的检查。

## 授权收件如何可追溯

`collect(source, store)` 的判定全部基于授权索引 `source.index`，从不读取 `source.bytes`：

- 每次请求只携带仍缺失的授权区间，预算 2 次、每次最多 4 个 Range，必带 `If-Match`；未授权空隙不会并入请求。
- 206 单部分与 `multipart/byteranges` 走同一套覆盖判定。multipart 只承认 HTTP 头声明的 boundary 分界，邮件正文中的形似分界字节不参与切分；服务端重排或合并相邻区间都按各部分 Content-Range 的绝对偏移入账。
- 每个部分先核对包大小（`/totalSize`）、授权覆盖与（重叠时的）字节一致性，再进入字节覆盖账本；200 整包、412 ETag 变化、未知范围、包大小不符一律不接纳。
- 原件只有在授权区间全部覆盖且重组字节的 sha256 与索引摘要一致时才落库；部分缺失时 `status` 为 `incomplete`，`pending` 逐封给出仍未闭合的字节区间，补领范围仍由原索引约束。
- Inbox 证据链保留三类材料：`authorization-index`（授权索引）、`http-exchange`（每次请求的 Range/If-Match/状态与原始回包）、`mail-original`（每封闭合原件及其索引偏移和摘要），`collection-runs` 记录本次收件结论，可逐封回溯到授权索引与实际收到的字节。

Linux 环境可用 `docker build -t mbox-receipt:local .` 预装依赖，然后 `docker run --rm --network none mbox-receipt:local` 验证底座。`docker run --rm --network none mbox-receipt:local npm run demo` 展示真实预览。所有测试来源在同一进程或容器内，network none 不限制容器 loopback。正式演示使用真实命令及完整输出，不回放日志；测试加预览的路径以90秒为上限。收件功能开发后的演示应在同一环境运行收件检查，不靠预设结果文本代替产品执行。

## 项目边界

来源和资料约定见 `docs/source-contract.md`，`acceptance/collection.test.mjs` 是集成方的公开输出契约。测试数据由来源模块或样本生成器提供，可修改参数添加边界，不能用公网真实业务数据替代。`src/store.mjs` 提供 SQLite 原件与收件记录存储，preview 本身不会声称已经完成业务接收。

数据文件写入可独立指定的 Inbox，测试默认用内存或临时目录。依赖目录、运行数据库与本机设置均不进入源码仓库。
