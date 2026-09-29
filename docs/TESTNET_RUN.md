# Sepolia 真实交易验证

运行日期：2026-09-29 UTC。网络固定为 Ethereum Sepolia（11155111），使用独立测试钱包。主网控制台保持停止。

## 验证对象

- 官方 IMD Hook #358：`cd74e008-6a11-47be-b242-012cc4529697`
- Token：`0x719e71f67c46c736885e412b41973edf4452150d`
- Hook：`0x3D13515ce40B463d88a3149371D54133165A1040`
- v4 Pool：`0xaf5929157e5342a1aa290d1ac01e9807b1c67eb0eaf8297eee59eed226bccdb9`
- 测试钱包：`0x3F54E5366BBb073C3964fA3f15441BCeda9dA60f`

官方来源：[IMD API 文档](https://imd.fun/docs/)、[该发行详情](https://api.imd.fun/launches/cd74e008-6a11-47be-b242-012cc4529697)。选择的是已上线测试币，本次验证不测量新币发现或首笔成交排名。

## 已核验的前置条件

官方 API 记录、发射交易、注册事件、代币与池参数通过现有 `resolveApiLaunch` 校验；当前 Uniswap v4 合约代码指纹由 Sentio 与 PublicNode 在同一区块交叉验证。

公共 Sepolia PublicNode 的历史 `eth_getCode` 查询出现 `-32000`，不能独立完成本次发射证据验证；Sentio 成功，因此测试工具使用 Sentio 作为主读节点，PublicNode 参与当前代码交叉核验和广播。

以实际测试钱包在块 11805973 读取的 0.0001 Sepolia ETH 报价为 4962.98560106950528639 tokens，1% 滑点对应最低输出 4913.355745058810233526 tokens。这是当时的链上报价，实际成交结果需以交易回执及钱包余额为准。

## 命令与限制

```sh
npm run testnet -- prepare cd74e008-6a11-47be-b242-012cc4529697
npm run testnet -- buy cd74e008-6a11-47be-b242-012cc4529697
npm run testnet -- status
```

固定买入 0.0001 Sepolia ETH，滑点 1%，最高 Gas 费用 0.002 Sepolia ETH。签名前校验余额、nonce、协议和区块；签名后解码确认 chainId、金额、接收合约和交易字段。交易哈希持久化后才允许向两节点广播同一份签名。等待两次确认并检查净到账；不确定状态只能查询原交易，不自动重买。

测试钱包私钥仅在 `runtime/testnet/wallet.env`，权限 0600，不进入仓库。测试执行不读取主网 `.env`，不修改主网配置，不使用 Anvil 或本地买卖回放。

## 真实交易结果：成功

通过 [OpenFaucet](https://openfaucet.org/ethereum-sepolia) 免费取得 0.012 Sepolia ETH，[到账交易](https://sepolia.etherscan.io/tx/0x8b0b10d7f3054ef464e41b25acc8b3a51849035465f410b72e5e62a5914a49df)已成功。没有支付主网资产或购买测试币。

[买入交易](https://sepolia.etherscan.io/tx/0x4e9e9f84203086dfca57b1b0f6f3f4c4f2fcdb06a9b7eb4f1aa90d021e6ca708)在块 **11805984** 成功执行：

| 项目 | 实际结果 |
| --- | --- |
| 花费测试 ETH | 0.0001 |
| 代币净到账 | 4962.98560106950528639 |
| Gas 使用量 | 173256 |
| Gas 花费（测试 ETH） | 0.0001905695630394 |
| 剩余测试 ETH | 0.0117094304369606 |
| 执行状态 | 成功；已验证两次确认及净到账达到最低输出 |
| 独立复核 | PublicNode 复核成功回执、区块哈希、余额，复核时已三次确认 |

工具退出码为 0，持久化状态为 `confirmed`，不能再次买入。测试使用与主网相同的 API 发射核验和 v4 编码模块，但由独立的 Sepolia 执行器完成；主网控制台仍为停止状态，未导入主网钱包。

[公开执行证据](evidence/sepolia-live-buy-2026-09-29.json)包含水龙头交易、报价、买入回执和独立节点复核。TypeScript 检查与 194 项自动化测试全部通过。

这次证明了该已上线 Hook 池上的真实买入与到账。没有进行卖出测试、新发行发现计时或主网成交；不能据此宣称主网版本已验证、未来可以卖出、零税或能够抢到首笔。
