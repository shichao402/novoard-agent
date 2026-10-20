// 本文件由 scripts/gen-contract-types.mjs 自动生成，请勿手工修改。
// 来源：契约 schema（共 12 张，按目录动态发现）。
// 如果手工改这里，CI 会因为生成物与 schema 不一致而失败（需求 2.3 / 2.8）。

/** 隧道私有信封（hub ↔ agent，契约 §4.2） */
export type A2aEnvelope = {
  "v": 1;
  "kind": "ops" | "a2a" | "ack";
  /** 信封级幂等 id，重发同 msgId 即重放（契约 §4.4） */
  "msgId": string;
  "ts"?: string;
  "taskId"?: string;
  /** 完整帧对象：ops 时为 §3.1 帧原样，a2a 时为 JSON-RPC 消息原样 */
  "body"?: Record<string, unknown>;
  /** ack 专用：true 表示此前已收过（重复投递） */
  "dedup"?: boolean;
};

/** Agent Card（单成员；聚合 card 附 x-novoard-members 扩展字段） */
export type AgentCard = {
  "name": string;
  "description": string;
  "version": string;
  "capabilities": {
    "streaming": boolean;
    "pushNotifications": boolean;
  };
  "defaultInputModes": string[];
  "defaultOutputModes": string[];
  /** 稳定角色标签，例如 office-pc。其他成员按此筛选，不广播询问。 */
  "x-novoard-role"?: string;
  "skills": ({
    /** skill id = target id（契约 §2 生成规则） */
    "id": string;
    "name": string;
    "description": string;
    "tags"?: string[];
    /** 私有扩展（契约 §2，v1.1）：target offline 策略随 card 透传给 hub 路由 */
    "x-novoard-offline"?: {
      "policy": "reject" | "queue";
      "ttl"?: string;
    };
    /** 私有扩展（契约 §2，M3）：target notify 策略透传，hub 终态通知前查表过滤 */
    "x-novoard-notify"?: "always" | "on-failure" | "never";
    /** 私有扩展（契约 §1.1）：单次运行上限 */
    "x-novoard-timeout"?: string;
    /** 私有扩展（契约 §1.1）：成员断开后判定 agent-lost 的等待上限 */
    "x-novoard-lost"?: {
      "ttl": string;
    };
    /** 私有扩展（契约 §1.1）：input-required 审批等待上限 */
    "x-novoard-approval"?: {
      "ttl": string;
    };
    /** 自然语言对话技能。不进全局 skill 路由表，多台成员可以同时声明。 */
    "x-novoard-kind"?: "agent";
  })[];
  /** 聚合 card 专用：member id → 寻址信息 */
  "x-novoard-members"?: {
    [key: string]: Record<string, unknown>;
  };
};

/** 审计流水 JSONL 单行事件（契约 §6） */
export type AuditEvent = {
  "ts": string;
  /** human / client-id / agent-cron / rule-engine */
  "actor": string;
  "lane": "a2a" | "ops" | "local";
  "target": string;
  "taskId"?: string;
  "outcome": "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected" | "accepted";
  "audit"?: "none" | "summary" | "full";
  "member"?: string;
  "detail"?: Record<string, unknown>;
};

/** ops 帧 agent.hello.ack（hub → agent，注册成功确认，契约 §4.2） */
export type FrameAgentHelloAck = {
  "type": "agent.hello.ack";
  /** hub 侧仍在途、要求 agent 对账的任务 id（契约 §4.4） */
  "inFlightTaskIds": string[];
  /** hub 侧契约版本，便于 agent 记录双方版本（契约 §8 可观测性） */
  "hubVersion"?: string;
};

/** FrameAgentHelloAck 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */
export type FrameAgentHelloAckInbound = FrameAgentHelloAck & { readonly [key: string]: unknown };

/** ops 帧 agent.hello.nack（hub → agent，注册被拒回执，契约 §4.2） */
export type FrameAgentHelloNack = {
  "type": "agent.hello.nack";
  /** 拒绝原因。contract-major-mismatch 为主版本不匹配；contract-schema-mismatch 为 hello 帧字段级校验失败，携带 detail 便于定位 */
  "reason": "contract-major-mismatch" | "contract-schema-mismatch" | "agent-identity-mismatch" | "instance-conflict";
  "hubVersion": string;
  /** hello 里带的 contractVersion 回显，便于对端确认自己发的是什么 */
  "agentVersion"?: string;
  "retryable"?: boolean;
  /** 字段级校验错误的实例路径与原因，逐条列出 */
  "detail"?: string[];
};

/** FrameAgentHelloNack 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */
export type FrameAgentHelloNackInbound = FrameAgentHelloNack & { readonly [key: string]: unknown };

/** ops 帧 agent.hello（注册 / 重连） */
export type FrameAgentHello = {
  "type": "agent.hello";
  "contractVersion": string;
  "agentId": string;
  "card": AgentCard;
  /** 进程启动时生成，只放内存。同一进程重连不变，进程重启才变（契约 §4.4） */
  "bootId"?: string;
  /** 重连时上报在途任务，供 hub 对账（契约 §4.4） */
  "inFlightTaskIds"?: string[];
};

/** FrameAgentHello 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */
export type FrameAgentHelloInbound = FrameAgentHello & { readonly [key: string]: unknown };

/** ops 帧 agent.ping（心跳，双向） */
export type FrameAgentPing = {
  "type": "agent.ping";
  "ts": string;
};

/** FrameAgentPing 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */
export type FrameAgentPingInbound = FrameAgentPing & { readonly [key: string]: unknown };

/** ops 帧 card.update（target 定义变更后推送） */
export type FrameCardUpdate = {
  "type": "card.update";
  "card": AgentCard;
};

/** FrameCardUpdate 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */
export type FrameCardUpdateInbound = FrameCardUpdate & { readonly [key: string]: unknown };

/** ops 帧 frame.reject（hub → agent，通用帧拒绝回执，契约 §4.2） */
export type FrameReject = {
  "type": "frame.reject";
  /** 被拒帧的信封 msgId，供对端把拒绝关联回具体发送物 */
  "refMsgId": string;
  /** 拒绝原因。ops-schema-mismatch 为帧 body 不符合 schema；unknown-ops-type 为 type 不在 ops 枚举内 */
  "reason": "ops-schema-mismatch" | "unknown-ops-type" | "frame-too-large" | "internal-error";
  "hubVersion": string;
  "retryable"?: boolean;
  /** 字段级错误的实例路径与原因，逐条列出 */
  "detail"?: string[];
};

/** FrameReject 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */
export type FrameRejectInbound = FrameReject & { readonly [key: string]: unknown };

/** ops 帧 telemetry（可选，频率配置） */
export type FrameTelemetry = {
  "type": "telemetry";
  "ts": string;
  "cpuPct": number;
  "memPct": number;
  "diskPct": number;
};

/** FrameTelemetry 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */
export type FrameTelemetryInbound = FrameTelemetry & { readonly [key: string]: unknown };

/** Novoard target 定义（agent 侧 YAML 转 JSON 后校验，启动自检用） */
export type Target = {
  "targets": {
    [key: string]: TargetDefTarget;
  };
};

export type TargetDefTarget = { "steps": unknown } | { "template": unknown };

export type TargetDefStep = TargetDefStepScript | TargetDefStepOpenApp | TargetDefStepOpenPath | TargetDefStepTemplate;

export type TargetDefStepScript = {
  "script": string;
  "cwd"?: string;
  "env"?: {
    [key: string]: string;
  };
};

export type TargetDefStepOpenApp = {
  "openApp": string;
};

export type TargetDefStepOpenPath = {
  "openPath": string;
};

export type TargetDefStepTemplate = {
  "template": string;
};

/** A2A task 对象（字面对齐 A2A spec，契约 §5.2） */
export type Task = {
  "id": string;
  /** 父任务关联：hub 下发时父任务 id，agent 上行原样带回（契约 §4.3） */
  "contextId"?: string;
  "kind": "task";
  "status": {
    "state": "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected";
    "timestamp"?: string;
    "message"?: string;
  };
  "artifacts"?: {
    "name": string;
    "description"?: string;
    "metadata"?: {
      "artifactId"?: string;
      "taskId"?: string;
      "member"?: string;
      "target"?: string;
      "digest"?: string;
      "size"?: number;
    };
    "parts": {
      "kind": string;
      "text"?: string;
      /** 超限 artifact 走上传端点后以 URL 引用（契约 §7） */
      "uri"?: string;
    }[];
  }[];
  "history"?: Record<string, unknown>[];
  "metadata"?: Record<string, unknown>;
  /** 追加运行记录，只用于追溯，不用于恢复执行（契约 §4.5） */
  "trace"?: ({
    "seq": number;
    "type": "run/start" | "step/start" | "step/end" | "run/end" | "run/truncated";
    "ts": string;
    "taskId": string;
    "target"?: string;
    "bootId"?: string;
    "timeout"?: string;
    "index"?: number;
    "command"?: string;
    "exit"?: number;
    "state"?: string;
    "last"?: Record<string, unknown>;
  })[];
};
