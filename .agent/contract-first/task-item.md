# 实施计划

- [ ] 1. 调整九张 schema 的字段演进策略（两仓同步）
   - hub 侧修改 `docs/architecture/schemas/` 下九张 schema：帧类（`frame-agent-hello` / `frame-agent-ping` / `frame-telemetry` / `frame-card-update`）的 body 层改为 `additionalProperties: true`，信封层与 `agent-card` / `task` / `audit-event` / `target` 维持严格
   - `agent.hello.nack` 按需求 3 补充字段：失败原因、`hubVersion`、可选 `retryable`
   - 同步拷贝到 agent 侧 `src/contract/schemas/`，保持逐字节一致
   - 在 `docs/architecture/contracts.md` §0 标明哪些 schema 保持封闭及其理由
   - _需求：1.1、1.2、1.3、1.6、1.8、1.9、3.9_

- [ ] 2. 两侧校验器放开帧层未知字段并保留原值
   - hub 侧 `src/frames.mjs` 与 agent 侧 `src/contract/frames.mjs` 改为等价逻辑：帧体校验通过后保留未声明字段原值
   - 补充单元测试：含未知字段的 hello、telemetry、card.update 均可通过，含未知字段的信封仍被拒
   - _需求：1.2、1.3、1.7、1.8_

- [ ] 3. 消除三处硬编码 schema 清单，改为目录动态发现
   - hub `src/frames.mjs`、hub `scripts/check-contract-copy.mjs`、agent `scripts/check-contract-copy.mjs` 均改为读取目录动态枚举 schema
   - 补充测试：新增一个临时 schema 文件时，三处均能发现；删除/重命名文件时门禁失败并指出文件名
   - _需求：6.2、6.5、6.6_

- [ ] 4. hub 侧把两处静默丢弃改为显式回执
   - `src/tunnel.mjs` 信封校验失败分支（约 81 行）：能解析 `msgId` 时回带 `msgId` 的错误回执，否则以可读原因关闭连接，不再仅打日志后 return
   - `src/tunnel.mjs` ops body 校验失败分支（约 153 行）：将 `type` 判定前移到 body 校验之前，`agent.hello` 失败时回 `agent.hello.nack` 并携带校验错误路径，其他类型回带 `msgId` 的通用 nack
   - 补充测试：构造带未知字段的 hello，断言收到 nack 而非静默；构造非法信封，断言连接被关闭且原因可读
   - _需求：3.1、3.2、3.5、3.7、3.8_

- [ ] 5. agent 侧增加 hello 确认超时与明确报错
   - `src/tunnel-client.mjs` 在发送 `agent.hello` 后启动有限超时等待确认或 nack
   - 超时未收到任何回执时，输出"疑似契约不兼容"并进入可识别的失败状态，不再保持静默连接
   - 收到 nack 时解析原因与 `hubVersion`，写日志并上报到 UI 状态
   - 补充测试：模拟不响应回执的服务端与返回 nack 的服务端，断言两种路径都产生明确失败
   - _需求：3.3、3.4、3.5、3.6_

- [ ] 6. 收窄契约版本号至单一来源
   - hub `src/tunnel.mjs` 的 `CONTRACT_VERSION` 作为唯一常量，统一为不带 `v` 前缀的字面格式
   - agent 侧新增契约版本常量模块，由 `src/contract/` 派生；`scripts/check-contract-copy.mjs` 的 `v2.1` 改为引用该常量，`src/config.mjs` 删除 `contractVersion` 的默认值与配置读取
   - 启动时若检测到 `agent.json` 中存在历史 `contractVersion`，忽略并以常量取代，写一条提示日志，不回写该字段
   - 补充测试：带旧版本号的配置文件不影响握手；版本号不一致时门禁报错并指出两处位置
   - _需求：4.1、4.2、4.3、4.4、4.5、4.6、4.7、8.4_

- [ ] 7. 建立跨仓共享一致性夹具
   - 在 hub 仓新增夹具目录，放版本化样本：每类帧各含合法样本与应拒样本，另含未知字段可接受、信封未知字段应拒、主版本不匹配、缺必填字段等用例，每个样本附预期结论
   - hub 侧新增夹具执行器并接入 `npm test`；agent 侧以只读方式加载同一目录并接入自身测试
   - 夹具目录带版本标记，与 schema 版本不匹配时明确报错
   - _需求：5.1、5.2、5.3、5.4、5.5、5.6、5.7_

- [ ] 8. 修正两侧契约门禁口径
   - hub `scripts/check-contract-copy.mjs`：保留 SSOT 自检，增加跨仓一致性判定入口，失败输出指明仓库、文件、未同步一侧
   - agent `scripts/check-contract-copy.mjs`：比对对象从固定历史提交改为当前 SSOT，SSOT 不可达时明确报错而非默认通过
   - 两侧 CI 均纳入夹具执行与门禁，确保新增/删除 schema 文件都会失败
   - _需求：6.1、6.3、6.4、6.7_

- [ ] 9. 从 schema 生成 TypeScript 类型并在两侧生效
   - 新增生成器脚本，从 schema 目录生成 `.d.ts`；遇到不支持的关键字显式报错并指出关键字与文件，不生成部分类型
   - 生成物标注为机器生成；两侧分别提交生成物，CI 校验生成物与 schema 一致，并校验两侧生成结果等价
   - 两侧关键模块（`src/frames.mjs` / `src/contract/frames.mjs` / `src/tunnel.mjs` / `src/tunnel-client.mjs`）以 JSDoc 引用生成类型，开启 JS 类型检查
   - 补充测试：篡改字段名后类型检查报错；忘记重新生成时 CI 失败
   - _需求：2.1、2.2、2.3、2.4、2.5、2.6、2.7、2.8、2.9、2.10_

- [ ] 10. 补全契约文档双向兼容规则与运行时可观测性
   - `docs/architecture/contracts.md` 补写两个方向的兼容行为、次版本新增字段时旧实现的预期行为、主版本破坏点清单；文档示例与 schema 冲突时由 CI 检出
   - hub 状态端点返回当前契约版本；agent 注册日志记录双方契约版本与 `msgId`，拒绝时两侧可通过同一 `msgId` 关联
   - 在两个仓的发布说明模板中增加配套发布窗口说明，明确单侧先发时的行为
   - _需求：7.1、7.2、7.3、7.4、7.5、8.1、8.2、8.3_
