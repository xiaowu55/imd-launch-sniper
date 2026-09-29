# WS 与公共 RPC 池实测及选择

2026-09-29 UTC，本机当前网络测量。所有请求只读 Ethereum 主网；没有本地买卖模拟、签名或交易广播。结果不代表其他地区、后续时段或真实成交排名。

## 选择

采用分工方案：**链上新区块通知用 PublicNode WS + dRPC WS；资料查询用 PublicNode HTTP 主、dRPC HTTP 备；真实广播继续并发提交同一份签名交易。**

当前默认仍是 API 发现模式，**该模式不会连接 WS**。它必须先取得官方发行资料，WS 不能替官方 API 确定首个 IMD 主网币。新增第二路 WS 是高级链上模式的推送备用；其 HTTP 定时补扫保留。

普通读取暂不改成每次都向两家同时请求：本次验证过的并发 HTTP 池对块和代码读取没有改善，日志读取中位数只减少约 3 ms。保留主备可避免日常请求量翻倍。签名交易广播本来就是并发的，没有因此增加买入次数。

## 新区块通知：同一 blockHash 到达时间

两家提供商同时测 WS `newHeads` 与 HTTP `eth_getBlockByNumber("latest", false)`，HTTP 每个节点按 1 秒起始间隔轮询、同节点不重叠。池结果取两提供商的最早有效观察时间。使用本机 `performance.now()`，不把区块时间戳当网络时钟，也不把等待下一块的整段时间当请求延迟。

| 轮次 | 观察时长 | 已校对配对区块 | WS 先到 | HTTP 池比 WS 池晚到的中位数 | P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 第一轮 | 240 秒 | 20 | 20 / 20 | 512 ms | 911 ms |
| 第二轮 | 120 秒 | 10 | 10 / 10 | 678 ms | 895 ms |
| 合并观察 | 360 秒 | 30 | 30 / 30 | 574 ms | 911 ms |

每个比较区块都通过两家 HTTP 按块号重读校对哈希。第二轮观测集合中的 10 个 canonical 区块全部被四条路径观察到；HTTP-only、WS-only、核验失败、哈希分歧均为 0，WS 连接错误为 0。这只是本次已观察集合的覆盖，不是完整链的漏报率或长期可用率。

PublicNode WS 在第二轮全部 10 个区块最早到达；dRPC WS 中位晚 115 ms。第一轮存在 PublicNode WS 明显晚于 dRPC WS 的个例，所以保留第二路通知，而非仅依赖最快的一个连接。

证据：[第一轮通知记录](evidence/rpc-heads-first-pass-2026-09-29.json)、[第二轮完整校验记录](evidence/rpc-benchmark-2026-09-29.json)、[合并摘要](evidence/rpc-comparison-summary-2026-09-29.json)。第一轮的固定读取未逐次校验内容，因此没有用于下面的读取性能选择。

## RPC 查询：经过内容校验的暖连接固定块读取

第二轮固定块为 **26081285**，每条路径、每种方法 20 次。括号内为 P95，单位 ms。

| 传输 | 读取区块 | 读取 PoolManager 日志 | 读取 PoolManager 代码 |
| --- | ---: | ---: | ---: |
| PublicNode HTTP | **149（159）** | **388（404）** | 160（170） |
| PublicNode WS RPC | 134（143） | 624（638） | 156（176） |
| dRPC HTTP | 251（261） | 389（478） | 267（278） |
| dRPC WS RPC | 242（251） | 392（455） | 266（292） |
| 双 HTTP 并发取首个有效结果，仅作对照 | 149（159） | 385（391） | 160（170） |

全部 240 次固定块请求通过内容校验，没有错误。区块响应必须匹配固定块号和哈希；代码必须匹配内置 PoolManager 代码指纹；日志逐项校验区块、地址、交易与索引，再与两家 HTTP 预先核对一致的日志摘要比较。完成后再次确认固定块未重组。空响应、错块、错误代码或缺失日志不能靠返回得快进入成功 RTT。

并发读取池对照由同时发出的两个 HTTP 请求的有效完成时间计算，**不是当前生产读取实现**。PublicNode 在 20 次块/代码读取中均先于 dRPC，日志读取中 PublicNode 13 次先到、dRPC 7 次先到。

这些固定历史块请求可能命中上游缓存。它们不等价于首次出现的新交易回执，也没有测量 `eth_sendRawTransaction` 的传播或上链速度。WS 在测量期间同时承载订阅与 RPC 请求；不能从这个小样本推出“WS 永远更快”或“HTTP 永远更快”。

## 当前首币路径的实际约束

官方 API 补测 4 轮、共 12 请求全部成功：列表返回 `max-age=10`，详情返回 `max-age=30`，部署 reads 没有返回缓存时长。完整下载的中位数分别为 **646 / 618 / 425 ms**。响应没有 `Age` 或 `CF-Cache-Status`，这些头不能证明实际缓存命中，更不能量出一个新币何时首次对外可见。4 个样本也不足以推断稳定尾延迟。

测量时四轮列表均有 166 条记录、Ethereum 主网 `live` 为 0；没有实测 IMD 主网发币到成交全过程。全市场 Uniswap v4 的建池通知不能证明是官方 IMD 发射，不能跳过官方身份和链上回执核验直接购买。

已把官方详情与部署 reads 改成并行获取；完成后仍核对 ID、链、源码提交、证明、产物与同笔交易。这去掉了一次串行网络等待，但没有承诺固定节省多少时间，也没有更改官方缓存策略。失败分支与原先的身份错误优先级保持一致。

API 证据：[api-latency-2026-09-29.json](evidence/api-latency-2026-09-29.json)。

## 复测

```sh
npm run rpc:benchmark -- 240 runtime/rpc-benchmark.json
```

可指定 120–600 秒通知观察窗口；之后另测固定块读取。完整命令通常比窗口多约一分钟。此脚本只使用公开端点，不读取本地钱包或带密钥的配置。实现和错误响应回归见 `scripts/benchmark-rpc.ts`、`scripts/rpc-benchmark-validation.ts`、`test/rpc-benchmark-validation.test.ts`。

本次代码修改通过 TypeScript、前端语法和 **191 项测试**。本页是读性能选型记录，不替代既有安全审计，亦不证明实际买入安全或未来卖出能力。

官方参考：[PublicNode 端点](https://ethereum.publicnode.com/)、[dRPC HTTP/WSS 端点](https://drpc.org/docs/ethereum-api)、[dRPC 公共节点限制](https://drpc.org/docs/howitworks/ratelimiting)、[Geth 订阅语义与连接限制](https://geth.ethereum.org/docs/interacting-with-geth/rpc/pubsub)。
