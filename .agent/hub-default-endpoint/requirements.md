# 需求文档：Hub 默认地址（编译期默认值 + 分层覆盖）

## 引言

当前 Agent 必须由用户在安装向导里手工填写 Hub 地址，而实际部署中绝大多数客户端只会连同一个地址。同时 `edition.json` 已经存在 `release` / `dev` 两档，各自带独立的 `localPort`，具备承载「按档位烘焙默认地址」的现成结构。

本功能的目标是：让同一份源码通过构建期烘焙产出两个各自指向正确 Hub 的产物，安装时无需填地址；同时在配置解析链中补齐优先级首尾两层，并坚守「只存偏离量、不存储派生值」的原则，避免把编译期即可推导的值固化进用户配置文件。

需要特别澄清一个边界：本功能**不能**让全新机器免配置。`agentId` 与 `agentToken` 仍必须由用户提供，`agent.json` 仍必须存在。默认地址解决的是「少填一个字段」以及「换域名时不必逐台改文件」，不是零配置启动。

本需求文档分为两期。第一期（需求 1–4）为低风险改动，仅涉及构建期烘焙、配置兜底、向导写入条件判断与测试同步，不改动现有优先级语义。第二期（需求 5–6）涉及行为变更，需单独评审后实施。

## 需求

### 需求 1

**用户故事：** 作为构建维护者，我希望 Hub 默认地址按构建档位烘焙进产物，以便正式版与开发版各自连向正确的服务端，无需在运行时代码里做分支判断。

#### 验收标准

1. WHEN 构建脚本读取 `edition.json` THEN 系统 SHALL 从被选中档位读取 `hubUrl` 字段，并将其与 `localPort` 等同级烘焙进 `src/edition.gen.mjs`。
2. IF 被选中档位缺少 `hubUrl` 字段 THEN 系统 SHALL 在构建阶段失败并给出明确错误，而不是在运行时才暴露地址缺失。
3. IF `hubUrl` 字段值无法通过 `normalizeHubUrl` 归一化 THEN 系统 SHALL 在构建阶段失败并指出该档位的具体值。
4. WHEN 执行 `npm run build` THEN 系统 SHALL 每次重新烘焙 `edition.gen.mjs`，使其内容与当前 `edition.json` 一致。
5. WHEN 完成构建 THEN 系统 SHALL 保证 `release` 档位默认地址指向生产域名，`dev` 档位默认地址指向本机 Hub，且两者不相等。

### 需求 2

**用户故事：** 作为运维人员，我希望 Hub 地址有完整的取值优先级链，以便在配置文件出错时能用环境变量临时覆盖，而不必修改已安装机器上的文件。

#### 验收标准

1. WHEN 解析配置 THEN 系统 SHALL 按「`agent.json` 显式值 → `NOVOARD_HUB_URL` 环境变量 → 编译期默认值」的顺序取值，任一环节取到非空值即停止。
2. IF `agent.json` 中 `hubUrl` 缺失且环境变量未设置 THEN 系统 SHALL 使用编译期默认值，且不因此将 `hubUrl` 判定为缺失字段。
3. WHEN 使用编译期默认值解析配置 THEN 系统 SHALL 返回归一化后的完整地址（含 `/tunnel` 路径与 `ws(s)` 协议前缀），确保后续 WebSocket 连接与 HTTP 派生均正确。
4. IF `agent.json` 不存在 THEN 系统 SHALL 仍返回配置缺失错误，不因存在默认地址而放行。
5. WHEN `agentId` 或 `agentToken` 缺失 THEN 系统 SHALL 仍将其列入缺失字段报告。
6. WHEN 配置解析成功 THEN 系统 SHALL 能通过现有 `hubHttpUrl` 派生逻辑得到正确的 HTTP origin。

### 需求 3

**用户故事：** 作为后续维护者，我希望安装向导只把偏离默认值的配置写入文件，以便将来默认地址变更时已装机器能自动跟随，无需逐台迁移。

#### 验收标准

1. WHEN 用户提交的 Hub 地址经归一化后等于编译期默认值 THEN 系统 SHALL 不将 `hubUrl` 字段写入 `agent.json`。
2. WHEN 用户提交的 Hub 地址经归一化后不等于编译期默认值 THEN 系统 SHALL 按现有逻辑将该地址写入 `agent.json`。
3. WHEN 写入完成后重新解析配置 THEN 系统 SHALL 得到与用户提交值等价的 Hub 地址，不因省略字段而改变实际连接目标。
4. IF 省略 `hubUrl` 字段 THEN 系统 SHALL 保持 `agent.json` 文件权限仍为 `0600`，且其余字段（`agentId`、`agentToken`、`localPort`、`uiHost`）行为不变。
5. WHEN 用户在向导中留空地址 THEN 系统 SHALL 采纳编译期默认值，并在连接测试中实际探测该地址，而非报「地址为空」。

### 需求 4

**用户故事：** 作为开发者，我希望既有测试与契约门禁随改动同步，以便明确验证默认值链路而不是靠人工判断。

#### 验收标准

1. WHEN 运行 `npm run test` THEN 系统 SHALL 通过 `edition` 相关测试，覆盖两个档位 `hubUrl` 存在、可归一化且互不相等。
2. WHEN 运行配置解析测试 THEN 系统 SHALL 覆盖三类场景：`agent.json` 显式值优先、环境变量兜底、两者皆缺时回落默认值。
3. WHEN 运行向导测试 THEN 系统 SHALL 覆盖「提交默认地址时不写字段」与「提交非默认地址时写入字段」两种情况，并断言落地后解析结果正确。
4. IF 现有测试断言 `agent.json` 中必须存在 `hubUrl` 字段 THEN 该断言 SHALL 调整为断言解析后的实际地址，而非断言字段存在性。
5. WHEN 运行 `npm run contract-gate` THEN 系统 SHALL 保持通过，不因本改动影响契约拷贝校验。

### 需求 5

**用户故事：** 作为运维人员，我希望契约版本号不再被持久化到用户配置文件，以便升级二进制后不再因陈旧版本号导致握手被拒。

#### 验收标准

1. WHEN 解析配置 THEN 系统 SHALL 按「`agent.json` 显式值 → `NOVOARD_CONTRACT_VERSION` → 契约单一来源常量」的顺序取值。
2. WHEN 安装向导写入配置 THEN 系统 SHALL 不再向 `agent.json` 写入 `contractVersion` 字段。
3. IF `agent.json` 中存在历史遗留的 `contractVersion` 字段 THEN 系统 SHALL 仍能读取，不因该字段存在而报错。
4. WHEN 契约版本常量为 `2.1` THEN 系统 SHALL 保证写入 `agent.hello` 的 `contractVersion` 满足 schema 约束 `^\d+\.\d+$`（不带 `v` 前缀）。

### 需求 6

**用户故事：** 作为使用者，我希望在握手前就能得知服务端契约版本，以便版本不兼容时看到明确提示而不是静默卡住。

#### 验收标准

1. WHEN 客户端在建立隧道连接前 THEN 系统 SHALL 通过只读端点获取服务端的产品版本与契约版本。
2. IF 服务端契约主版本与客户端不一致 THEN 系统 SHALL 在发起隧道连接前给出包含两侧版本号的明确提示，并终止启动。
3. IF 该只读端点不可达或返回非预期格式 THEN 系统 SHALL 回退到直接连接，不因预检失败而阻断可用连接。
4. WHEN 预检成功且主版本一致 THEN 系统 SHALL 继续正常建立隧道连接，不改变现有握手流程。
5. WHEN 预检被调用 THEN 系统 SHALL 不携带 `agentToken`，确保该端点无需鉴权即可访问。

## 非目标

- 不在本功能中新增第二套 Hub 实例（正式/测试环境分离属于部署决策）。
- 不改变 `agent.json` 的文件位置、权限与其余字段语义。
- 不引入向用户暴露 Hub 选择器的 UI。
- 不实现客户端自动升级或远程配置下发。
