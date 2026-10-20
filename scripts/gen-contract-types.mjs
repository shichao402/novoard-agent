#!/usr/bin/env node
/**
 * 契约类型生成器（需求 2）：从 JSON Schema 生成 TypeScript 声明。
 *
 * 设计约束：
 * - 生成物必须是机器可判定的：同一份 schema 内容在两个仓库必须产生逐字节相同的输出（需求 2.10）。
 *   因此输出不含绝对路径、不含时间戳、不依赖生成器所在仓库。
 * - 遇到无法映射的 schema 关键字必须显式报错并指出关键字与文件，不得静默生成不完整类型（需求 2.6）。
 * - schema 目录按目录动态发现，不维护手工清单。
 *
 * 用法：
 *   node scripts/gen-contract-types.mjs            # 生成
 *   node scripts/gen-contract-types.mjs --check    # 校验生成物是否与 schema 一致（CI 用）
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_REL = join("src", "contract", "generated", "contract-types.d.ts");

/** schema 目录：两侧仓库布局不同，按存在性自动定位，使本脚本在两仓可保持同一份内容。 */
function resolveSchemaDir(root) {
  const candidates = [join(root, "docs", "architecture", "schemas"), join(root, "src", "contract", "schemas")];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`找不到契约 schema 目录（尝试过：${candidates.join("、")}）`);
}

/**
 * 受支持的 JSON Schema 关键字白名单。
 * 不在表内的关键字一律报错——这保证 schema 演进时不会悄悄生成错类型。
 */
const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "$comment",
  "title", "description", "type", "format", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems",
  "default", "examples", "deprecated",
  "properties", "required", "additionalProperties", "items",
  "enum", "const", "oneOf", "anyOf", "allOf", "not", "if", "then", "else",
]);

/** 文件名 → 类型名（a2a-envelope → A2aEnvelope）。 */
function typeNameOfFile(file) {
  const base = file.replace(/\.json$/, "");
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function pascal(text) {
  return String(text)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** 递归检查 schema 关键字，遇到未知关键字立即报错（带文件与路径）。 */
function assertKeywordsSupported(schema, file, path = "#") {
  if (schema === null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => assertKeywordsSupported(item, file, `${path}/${i}`));
    return;
  }

  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      throw new Error(`无法映射的 schema 关键字：${key}（文件 ${file}，位置 ${path}）——请扩展生成器或改用受支持写法`);
    }
  }

  // properties：键是字段名，不是关键字，只递归其值
  if (schema.properties && typeof schema.properties === "object") {
    for (const [name, sub] of Object.entries(schema.properties)) {
      assertKeywordsSupported(sub, file, `${path}/properties/${name}`);
    }
  }
  // $defs 同理
  if (schema.$defs && typeof schema.$defs === "object") {
    for (const [name, sub] of Object.entries(schema.$defs)) {
      assertKeywordsSupported(sub, file, `${path}/$defs/${name}`);
    }
  }
  for (const key of ["items", "additionalProperties", "not", "if", "then", "else"]) {
    const value = schema[key];
    if (value && typeof value === "object") assertKeywordsSupported(value, file, `${path}/${key}`);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(schema[key])) {
      schema[key].forEach((sub, i) => assertKeywordsSupported(sub, file, `${path}/${key}/${i}`));
    }
  }
}

/** 收集跨文件 $ref 目标，供类型名解析。 */
function refTargetName(ref, currentFile) {
  if (ref.startsWith("#/")) {
    // 同文件内：$defs/xxx 或 properties/xxx
    const parts = ref.slice(2).split("/");
    if (parts[0] === "$defs" && parts[1]) {
      return `${typeNameOfFile(currentFile)}Def${pascal(parts[1])}`;
    }
    throw new Error(`暂不支持的内部 $ref 形式：${ref}（文件 ${currentFile}）`);
  }
  const [file, fragment] = ref.split("#");
  const baseName = typeNameOfFile(file);
  if (!fragment) return baseName;
  const parts = fragment.replace(/^\//, "").split("/");
  if (parts[0] === "$defs" && parts[1]) return `${baseName}Def${pascal(parts[1])}`;
  throw new Error(`暂不支持的跨文件 $ref 形式：${ref}（文件 ${currentFile}）`);
}

/** JSON Schema 片段 → TypeScript 类型表达式。 */
function toTs(schema, file, indent) {
  const pad = "  ".repeat(indent);

  if (!schema || typeof schema !== "object") return "unknown";

  if (schema.$ref) return refTargetName(schema.$ref, file);

  if (schema.const !== undefined) return JSON.stringify(schema.const);

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((sub) => toTs(sub, file, indent)).join(" | ");
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.map((sub) => toTs(sub, file, indent)).join(" | ");
  }

  // allOf：只合并能表达结构的成员；纯 if/then 条件约束不透出为类型（它会退化成 unknown 并吞掉基础结构）
  if (Array.isArray(schema.allOf)) {
    const structural = schema.allOf
      .filter((sub) => !(sub && typeof sub === "object" && sub.if !== undefined && sub.then !== undefined && sub.properties === undefined && sub.type === undefined))
      .map((sub) => toTs(sub, file, indent))
      .filter((t) => t !== "unknown");
    const own = schema.type || schema.properties || schema.additionalProperties !== undefined
      ? [toTs({ ...schema, allOf: undefined }, file, indent)]
      : [];
    const parts = [...own, ...structural].filter((t) => t && t !== "unknown");
    if (parts.length > 0) return parts.join(" & ");
    // 只剩条件约束：退化为宽松对象（条件约束已在运行时校验，类型层不额外收紧）
    return "Record<string, unknown>";
  }
  // 单独的 if/then 不是类型表达
  if (schema.if !== undefined || schema.then !== undefined || schema.else !== undefined) {
    const rest = { ...schema };
    delete rest.if;
    delete rest.then;
    delete rest.else;
    return Object.keys(rest).length > 0 ? toTs(rest, file, indent) : "unknown";
  }
  if (Array.isArray(schema.required) && !schema.properties && !schema.type && !schema.additionalProperties) {
    const obj = schema.required.map((key) => `{ ${JSON.stringify(key)}: unknown }`).join(" & ");
    return obj || "unknown";
  }

  const type = schema.type;
  if (Array.isArray(type)) return type.map((t) => toTs({ ...schema, type: t }, file, indent)).join(" | ");

  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";

  if (type === "array") {
    const item = schema.items ? toTs(schema.items, file, indent) : "unknown";
    const needsParen = item.includes(" | ") || item.includes(" & ");
    return `${needsParen ? `(${item})` : item}[]`;
  }

  if (type === "object" || schema.properties || schema.additionalProperties !== undefined) {
    const props = schema.properties ?? {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const lines = [];

    for (const [name, sub] of Object.entries(props)) {
      const desc = sub?.description ? `${pad}  /** ${String(sub.description).replace(/\*\//g, "*\\/")} */\n` : "";
      const optional = required.has(name) ? "" : "?";
      lines.push(`${desc}${pad}  ${JSON.stringify(name)}${optional}: ${toTs(sub, file, indent + 1)};`);
    }

    const ap = schema.additionalProperties;
    if (ap === true) {
      lines.push(`${pad}  /** 帧 body 层：允许对端新增未声明字段（契约 §0 演进策略） */`);
      lines.push(`${pad}  [key: string]: unknown;`);
    } else if (ap && typeof ap === "object") {
      lines.push(`${pad}  [key: string]: ${toTs(ap, file, indent + 1)};`);
    }
    // ap === false 或无 ap：不写索引签名，即封闭结构（需求 2.2）

    if (lines.length === 0) {
      return ap === false ? "Record<string, never>" : "Record<string, unknown>";
    }
    return `{\n${lines.join("\n")}\n${pad}}`;
  }

  return "unknown";
}

/** 生成单个 schema 声明块。 */
function emitSchema(file, schema) {
  const name = typeNameOfFile(file);
  const blocks = [];

  const isOpen = schema.additionalProperties === true;
  const title = schema.title ? `/** ${String(schema.title).replace(/\*\//g, "*\\/")} */\n` : "";

  if (isOpen) {
    // 帧类 schema 的两种视角（契约 §0 演进策略的落地方式）：
    // - 主类型严格：本端构造帧时，字段拼写错误、类型不符、缺必填字段都会在编译期报错（需求 2.5）。
    // - Inbound 类型带索引签名：接收对端帧时，次版本新增的未声明字段不会被误判为错误（需求 2.9）。
    // 用两个名字表达同一份 schema，是为了不让「接收要宽容」把「构造要严格」一起放松掉。
    const strictSchema = { ...schema };
    delete strictSchema.additionalProperties;
    blocks.push(`${title}export type ${name} = ${toTs(strictSchema, file, 0)};`);
    blocks.push(
      `/** ${name} 的入站视角：允许对端新增未声明字段（契约 §0）。用于接收/解析，不用于构造。 */\n` +
        `export type ${name}Inbound = ${name} & { readonly [key: string]: unknown };`,
    );
  } else {
    blocks.push(`${title}export type ${name} = ${toTs(schema, file, 0)};`);
  }

  if (schema.$defs && typeof schema.$defs === "object") {
    for (const [defName, defSchema] of Object.entries(schema.$defs)) {
      const defTypeName = `${name}Def${pascal(defName)}`;
      const defTitle = defSchema?.description ? `/** ${String(defSchema.description).replace(/\*\//g, "*\\/")} */\n` : "";
      blocks.push(`${defTitle}export type ${defTypeName} = ${toTs(defSchema, file, 0)};`);
    }
  }

  return blocks.join("\n\n");
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const schemaDir = resolveSchemaDir(ROOT);
  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) throw new Error(`schema 目录为空：${schemaDir}`);

  const parsed = [];
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8"));
    assertKeywordsSupported(schema, file);
    parsed.push([file, schema]);
  }

  const header = [
    "// 本文件由 scripts/gen-contract-types.mjs 自动生成，请勿手工修改。",
    `// 来源：契约 schema（共 ${files.length} 张，按目录动态发现）。`,
    "// 如果手工改这里，CI 会因为生成物与 schema 不一致而失败（需求 2.3 / 2.8）。",
    "",
  ].join("\n");

  const body = parsed.map(([file, schema]) => emitSchema(file, schema)).join("\n\n");
  const content = `${header}\n${body}\n`;

  const outPath = join(ROOT, OUT_REL);

  if (checkOnly) {
    if (!existsSync(outPath)) {
      console.error(`✗ 生成物缺失：${OUT_REL}——请运行 node scripts/gen-contract-types.mjs`);
      process.exit(1);
    }
    const current = readFileSync(outPath, "utf8");
    if (current !== content) {
      console.error(`✗ 生成物与 schema 不一致：${OUT_REL}——请重新运行 node scripts/gen-contract-types.mjs 并提交结果`);
      console.error("  提示：schema 变更后忘记重新生成，会造成类型与实际契约脱节。");
      process.exit(1);
    }
    console.log(`✓ 契约类型生成物与 schema 一致（${files.length} 张 schema）`);
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf8");
  console.log(`✓ 已生成 ${OUT_REL}（${files.length} 张 schema）`);
}

main();
