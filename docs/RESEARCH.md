> 历史研究记录：本版已改为实盘专用，移除了控制台演练、Anvil 往返模拟及相关运行依赖。下文早期探测/模拟结果仅说明当时测试网状态；不代表当前 API 模式会检测税率，也不代表主网成交验证。当前行为以 README.md 为准。

# IMD 发射与买入接口研究

核验时间为 2026-09-28 16:14 UTC。本文记录研究证据，不构成主网部署公告。只进行了公开 HTTP 查询和 JSON-RPC 读取，没有签名或广播交易。

## 当前状态

- [官方 API 文档](https://imd.fun/docs/)公开 `/launches`、`/launches/:id`、`/launch/policies` 和 `/reads/launch/:id`。它没有提供专门的“抢首发买入”接口。
- [全部 launch 列表](https://api.imd.fun/launches?limit=500)当次返回 158 条，最新编号为 426。已部署样本在 Sepolia，chain ID 为 `11155111`。其中 10 条早期记录的 `chainId=1`，但状态为 `abandoned`，没有部署地址；不能仅凭 API 的链 ID 判定主网上线。
- [当前 launch 政策](https://api.imd.fun/launch/policies)包括 `evm_project` v5、`univ4_hook` v4、`custom_token` v6。v6 创建于 2026-09-28，观察时尚无 `custom_token` launch 样本，不能把旧工厂事件兼容性推断为已经验证。
- IMD 的身份与付费服务已经使用 Ethereum mainnet。这与发射平台的新币部署是不同事项，见 [health](https://api.imd.fun/health) 和 [payment capabilities](https://api.imd.fun/requests/capabilities)。支付 0.5 IMD 发起一个制作任务不是购买新发行的代币。
- 文档的 `wss://api.imd.fun/agent` 是贡献节点的协议，不是已承诺的公开发币行情推送接口。API 的 `live` 状态也可能晚于链上部署。
- 未取得已公布且核验完毕的 Ethereum mainnet 或 Robinhood IMD 发射工厂地址、代码哈希和部署起点。官方 [RPC 参考](https://api.imd.fun/reads/rpcs/11155111)提及 Robinhood 链不等于发射平台已经部署到那条链。

## 买入路径

官方公开的 [frontend-for-contract 参考](https://api.imd.fun/reads/skill/frontend-for-contract)明确给出 Uniswap v4 买入方法。

1. 从已部署样本的 attestation manifest 取得 `pairedCurrency`、`fee`、`tickSpacing`，从部署产物取得代币与 hook。原生 ETH 为零地址，按地址升序构造 pool key。项目池的 hook 为零；hook 型发射需使用该次部署的 hook。
2. 以 `eth_call` 调用 V4 Quoter 的 `quoteExactInputSingle`。根据报价计算正数 `amountOutMinimum`。
3. 调用 Universal Router 的 `execute(bytes commands,bytes[] inputs,uint256 deadline)`。
4. `commands=0x10`，`inputs[0]=abi.encode(bytes actions,bytes[] params)`，`actions=0x060c0f`，分别是 `SWAP_EXACT_IN_SINGLE`、`SETTLE_ALL`、`TAKE_ALL`。
5. `params[0]` 编码 `(PoolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`；`params[1]` 编码 `(address inputCurrency,uint256 amountIn)`；`params[2]` 编码 `(address outputCurrency,uint256 amountOutMinimum)`。
6. ETH 买入时 `msg.value=amountIn`，无需 ERC-20 / Permit2 授权。广播前模拟完整 `execute`。

[evm-project-launch 参考](https://api.imd.fun/reads/skill/evm-project-launch)说明工厂用新币提供单边流动性，政策 v5 将开盘 FDV 设为 20 ETH。manifest 的 `initialPrice` 可能只是旧格式占位值，有政策时部署器会重算。因此真实 pool key 与价格应以链上 `Initialize` 和状态为准。

[custom-token-launch 参考](https://api.imd.fun/reads/skill/custom-token-launch)新增 `ProjectFactory.launchCustom`，允许定制转账规则和不同的 pool 份额、供应量、开盘估值。它要求发射与 PoolManager 流程精确转账，但该说明不能代替对新部署代码及实际买卖的核验。

接口必须绑定已部署版本。当前 Uniswap `v4-periphery` 的 `main` 分支 [IV4Router.sol](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Router.sol)已经新增 `minHopPriceX36` 字段，而上述 IMD 文档与本次 Sepolia 的已部署 Router 使用 5 字段编码。本次对已部署 Router 的真实 `eth_call` 成功验证了 5 字段编码；不能未经核验直接照搬最新源码的 tuple。

## Sepolia 已验证参考

[launch 426 的官方部署读取](https://api.imd.fun/reads/launch/01479536-860f-40ea-bfa5-79eace1533ef)返回 `network.json`，其交易基础设施如下。

| 合约             | Sepolia 地址                                 |
| ---------------- | -------------------------------------------- |
| PoolManager      | `0xe03a1074c86cfedd5c142c4f04f1a1536e203543` |
| Universal Router | `0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b` |
| Quoter           | `0x61b3f2011a92d183c7dbadbda940a7555ccf9227` |
| StateView        | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` |
| PositionManager  | `0x429ba70129df741b2ca2a85bc3a2a3328e5c09b4` |
| Permit2          | `0x000000000022d473030f116ddee9f6b43ac78ba3` |

以下 IMD 地址由成功交易及其日志观察得到，并非已取得验证源码的永久部署表。

| 角色                 | 观察到的地址                                 |
| -------------------- | -------------------------------------------- |
| 项目工厂             | `0x770e474e3d4eb5d8cdfd45ba2dea9a02ed5fc9fd` |
| 项目登记合约         | `0xb4cd04dcf5965c071ddbde8d4e2f4e4a7a4903f0` |
| Hook 工厂            | `0xa6b1728c29eb4300e306b63f5c7ec2edfc2ef7c5` |
| Hook 登记合约        | `0xbf159c0bcda5175eb58ec97db3e783239ff681c0` |
| 两笔样本的交易发送者 | `0x09ec38170e94532eddb57c69dfc4f1fdcd0d4a60` |

`config/sepolia.reference.json` 保存了这些合约及 Uniswap 合约在块 `11801641` 的非空 runtime code 的 Keccak-256 哈希。它是研究数据，不是可直接启用真实买入的配置。

## 事件与链上证据

两笔样本都在一笔交易中完成代币部署、PoolManager `Initialize`、`ModifyLiquidity` 和发射登记。使用 `Initialize` 时应核对同一 receipt 内的登记事件、工厂地址、发送者、代码哈希、token 与 hook，不能监听全部 Uniswap 新池后直接买入。

- 项目 426：[官方记录](https://api.imd.fun/launches/01479536-860f-40ea-bfa5-79eace1533ef)，块 `11797418`，交易 `0xac83707d5b74febc20645eddddfd970dba3a522cc8b081998a08cb3fcbd72291`。
- Hook 358：[官方记录](https://api.imd.fun/launches/cd74e008-6a11-47be-b242-012cc4529697)，块 `11794805`，交易 `0x2209040b7778c268124e04a343787cc5caf4a949e7af29b8268efd332f79109b`。
- 原始 tx、receipt、严格解码结果保存在 `docs/evidence/project-426.json` 与 `docs/evidence/hook-358.json`。项目交易的块哈希还交叉比对过 ethpandaops、Sentio、Tenderly 的返回结果。

在 Sepolia 块 `11801659`，项目 426 的 StateView `getLiquidity` 返回 **0**，但 Quoter 为 `0.001 ETH` 返回 `49627085152468411915572` 个 token 最小单位，采用 5% 滑点的完整 Universal Router `execute` 也通过 `eth_call`。这是单边初始流动性位于当前 tick 下方的结果，买入跨入对应区间即可成交，不能把“当前 active liquidity 为 0”当作绝对不能买的条件。读取和模拟证据在 `docs/evidence/project-426-simulation.json`。模拟仅用公开的已有资金账户作为 `from`，没有其私钥，没有签名、授权或链上状态改变。

项目 426 的 [固定 commit LaunchToken.sol](https://github.com/identity-md-launches/launch-426-room-part-2-6/blob/110c20efc6ce4e146e27d4c431c43935a7adf0b9/src/LaunchToken.sol)已逐行检查。其 `_transfer` 按同一个 `amount` 扣减和增加余额，无税费分支、owner、增发入口、pause、blacklist、升级或外部调用。构造函数一次性向部署者铸造 `10^27` 单位。这提供了测试样本源码不收转账税的静态依据；本次没有独立重编译并证明部署字节码与源码一致，也不能由此保证未来新币具有同样行为。

以下事件的完整签名 Keccak 与真实 topic0 精确匹配，indexed 布局及数据字段已用 viem 严格解码并与 API 样本交叉验证。字段名称是研究时赋予的描述性名称，未取得工厂官方完整源码或 ABI，故不能声称它们来自经过验证的合约源文件。

```solidity
event LaunchRecorded(
    uint64 indexed launchNumber,
    bytes32 indexed kind,
    bytes32 sourceCommit,
    bytes32 attestationHash,
    address[] artifacts,
    uint256[] lpTokenIds
);
// topic0 0x842d5f2a8e1a9d01abf8bc2b6269628d3a53f94e060e8fa6021414c5710382f0

event ProjectLaunched(
    uint64 indexed launchNumber,
    address indexed token,
    address distributor,
    address[] contracts
);
// topic0 0x741a1c2d4c16867f237cdc43ea17f3c325c58f2838a7fa3880d8a167f25a0f96

event Launched(
    uint64 indexed launchNumber,
    address indexed token,
    address indexed hook,
    address distributor,
    uint128 liquidity
);
// topic0 0x81a480ee97308470997e0b8b5cbc5ed561408e4757971c1366ce3d55a28185a4
```

`LaunchRecorded.kind` 为右侧补零的 bytes32 文本。项目样本为 `evm_project`，hook 样本为 `univ4_hook`。launchNumber 是全局工作流编号，有空缺，且较小编号可能更晚落地；“主网第一个币”不能写成 `launchNumber==1`，应限定官方主网部署起点以后第一笔符合目标的链上交易，按块号、交易索引排序。

## 延迟边界与尚未核验项

事件订阅是在部署交易落块后收到通知，常规方案只能尽快争取后续块。多个 RPC 广播同一份已签名交易可以缩短传播延迟，但不能保证区块内排序或全网第一个成交。

待处理交易观察可以提前发现发射意图。项目与 hook 样本的 selector 分别为 `0x89fa0839` 和 `0x30478bf4`，但本次没有取得完整调用参数 ABI、CREATE2 预测算法或主网工厂部署源码。不能根据这两个 selector 臆造 pending decoder，也不能假定候选代币地址在打包前已经可供普通 `eth_call` 报价。

要实现可靠的同块跟随，仍需主网正式工厂、完整调用 ABI / 可复现字节码、预测代币与 pool key 的方法、包含发射交易的 bundle 模拟及发送通道。若发射交易通过私有渠道提交，公共 mempool 也可能完全看不到。Robinhood 等链的排序机制和 RPC 能力需独立验证。

高级链上模式需要核实正式主网 factory / registry / deployer、runtime 哈希和目标 launch 类型。默认 API 模式现已从官方声明与链上实际交易自动取得发射来源，不需要手工填入这些字段；实际交易仍必须通过池、代码与执行检查。

## API 作为辅助发现入口（2026-09-28 复查）

[发射列表](https://api.imd.fun/launches?limit=500)实测响应头为 `Cache-Control: public, max-age=10`；[单条详情](https://api.imd.fun/launches/80fbf0ff-0ef1-4603-9351-9a626b87b2e0)为 `public, max-age=30`。这是可缓存时长，不是实际更新延迟的测量或 SLA。此时共 165 条记录，132 条 Sepolia live、22 条 Sepolia parked、1 条 Sepolia assembling、10 条主网 abandoned。不能用 `chainId=1` 单字段判定真实发币。

实际观察到 [#445](https://api.imd.fun/launches/a36cb67d-208f-4149-a31a-4a55cac4833c) 从 assembling 转为 admitted，已公开源码 commit、编译环境与合约资料，尚无部署 artifacts。已部署项目的[公开 read 文件](https://api.imd.fun/reads/launch/80fbf0ff-0ef1-4603-9351-9a626b87b2e0)包含 deployment.json 和 network.json，可取得代币地址、部署交易、区块与 Uniswap 合约；没有完整独立的官方主网工厂清单。

[官方文档](https://imd.fun/docs/)列出了公开 GET /launches、GET /launches/:id，以及 GET /reads/launch/:id。文档中的 wss://api.imd.fun/agent 是贡献节点签名握手和任务分配协议，没有公开的新币订阅协议。最初实现了 API 辅助唤醒；现已进一步实现下述独立 API 买入路径。attestation 编译产物哈希不能未经复现直接当作 runtime Keccak 白名单。

## 独立 API 买入与自动模拟验证

`src/api-launch.ts` 将官方 detail、deployment.json、network.json 与同笔 canonical receipt 互证，自动得到代币、Hook、PoolKey、工厂、登记地址及部署者。部署交易须成功，来源提交和 attestationHash 须与 LaunchRecorded 一致。固定 Uniswap v4 主网地址依据[官方部署文档](https://developers.uniswap.org/docs/protocols/v4/deployments)，运行代码指纹经 PublicNode 与 dRPC 独立读取一致。API 任意提供的 router 地址不会进入签名交易。

当前主网路由器 `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` 的部署提交可由 [Uniswap contracts 部署记录](https://raw.githubusercontent.com/Uniswap/contracts/main/deployments/1.md)追溯至 v4-periphery 提交 `3796e9c460b4ad5befd40163f5c14595e7aeb107`，该版本 [IV4Router](https://raw.githubusercontent.com/Uniswap/v4-periphery/3796e9c460b4ad5befd40163f5c14595e7aeb107/src/interfaces/IV4Router.sol) 使用五字段 ExactInputSingleParams，与本项目编码一致。

使用官方 API 与实际 Sepolia RPC，成功自动解析项目426及 Hook358，过程中没有填写 IMD 部署清单。随后用 `src/fork-probe.ts` 在本机临时 Anvil fork 完成买入、Permit2 授权和卖出，源链和 fork 保持同一 chainId、相同钱包公开地址。公共节点只提供读取，模拟没有交易私钥；所有状态写入均限定新建进程监听的 127.0.0.1 端口。

- [项目426证据](evidence/api-fork-project.json)：固定区块11801659；约8.2秒完成本机往返。
- [Hook358证据](evidence/api-fork-hook.json)：固定区块11794815；约8.6秒完成本机往返。

两者以0.001 ETH模拟买入，随后卖出所得代币，回收0.000994009184986669 ETH；核心池费每边0.3%，观测到核心交易之外额外扣损每边0%。这里的额外扣损指标排除了Gas与核心池费；它只描述当时地址、金额与状态，不能证明未来条件不变。没有主网真实成交记录，也没有测得首笔排名。
