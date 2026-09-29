# 主网与同块扩展接口

默认 `src/discovery.ts` 按 PoolManager.Initialize 寻找新池，再在相同成功回执中匹配可信 registry 的 LaunchRecorded，核对 factory 和 EOA 发送者。已对 Sepolia 两种发射记录的事件字节布局核验；custom_token 未有样本，新主网升级仍需验证。

通过环境变量 `IMD_ADAPTER_PATH=/absolute/path/adapter.ts` 可替换确认后发现器。模块默认导出 `LaunchAdapter`，实现 `discover(fromBlock,toBlock,context)`，返回经过验证的 Candidate 数组。适配器是可信本地代码，与服务拥有相同权限，不能从不可信 URL 动态加载。

适配器入口内容指纹参与历史扫描游标的区分，改变内容会重新审查历史，并以新模块 URL 加载。自定义适配器应交付为单文件 bundle；只改外部依赖文件不会自动改变入口指纹，依赖变动时必须重新构建 bundle。正式工厂若支持“创建工厂与发币在同一笔交易内完成”，需验证对应事件和调用路径：当前默认发现器要求交易直接调用已知工厂，不能声称覆盖尚未验证的新部署方式。

`Candidate` 必须由指定范围内 canonical receipt 得到，携带 token、完整 PoolKey、poolId、launchNumber、kind、launchTxHash、blockNumber、blockHash、transactionIndex 和 logIndex。主引擎会再次排序、检查 PoolKey、筛选、报价和预算。不得把网页/API 传来的地址直接标记为已验证。

## Pending 路径尚需补齐

`LaunchAdapter.pending` 是预留接口，当前控制台执行循环**不调用**它。首先取得正式工厂完整 ABI、字节码与部署算法，然后实现以下部分：

1. 多节点 `newPendingTransactions`，筛选官方 factory 和 sender；去重、有界队列、并发限制。RPC 未暴露原始签名交易时不能强行构造。
2. 解码整个发射调用，确认准确类型、启动编号、CREATE/CREATE2 token 地址、PoolKey 和 Hook，不能只看四字节 selector。
3. 在包含发射交易的 fork 或多交易模拟中验证 token 运行代码、买卖限制、税率与 ETH 精确输入报价。代币尚不存在时，普通 latest `eth_call` 不能提供正确报价。
4. 用 `buildBackrun` 编码并签名买入。该模块会校验真实发币签名、chainId、factory、sender、PoolKey、税率策略、滑点、nonce 和预算，但 **adapter 提供的预测地址、税率证据和报价仍须由第 3 步证明**。
5. 把 `[rawLaunchTx, signedBuyTx]` 传给 `FlashbotsRelay.simulateBundle`，只有全部交易模拟成功才能调用 `sendBundle`。目标是 head+1，固定模拟状态块，不能将发币交易设成允许回滚。
6. 接入与确认后路径相同的 Journal 锁，签名前保留唯一候选和 nonce，发往 relay 前写入买入 hash。两条路径必须互斥，不能各用一个 nonce 重复下单。候选 pending 的先后顺序不保证最终链上第一个发射。
7. 逐块检查上链与 reorg；未包含时重验候选、费用、deadline 后再决定是否提交，禁止无上限重签或金额递增。成功广播后停止其他路径。

`src/relay.ts` 已实现官方认证签名、请求超时、结果完整性校验以及模拟和提交绑定。relay 接收仅表示收到 bundle，仍需链上回执才能认定成交。发送给 relay 的签名交易是可执行授权，演练模式不能调用签名/提交路径。

官方协议参考：[Flashbots JSON-RPC](https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint)。
