/**
 * dsh-plugin-checkup —— DSH 插件体检
 * 扫描已装插件，按「治什么病」分类、查重复能力、查未启用、查更新、看体积。
 * 只读本地文件，不改任何东西。
 */
import { defaultProfilesDir, scanProfiles, checkup, fetchLatestVersions } from "./lib/inspect.mjs";

let defineTool = null;
let z = null;
try {
  const dt = await import("@deepseek-ai/dsh-tools");
  defineTool = dt.defineTool;
} catch {
  /* 本地等价实现 */
}
try {
  const sm = await import("@deepseek-ai/schemastery");
  z = sm.default;
} catch {
  /* 没有 Config 也能跑 */
}

function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, def] of Object.entries(spec || {})) {
    if (!def || typeof def !== "object") continue;
    if (def.required === true) required.push(key);
    const { required: _omit, ...rest } = def;
    properties[key] = rest;
  }
  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}
if (!defineTool) defineTool = (options) => ({ ...options, parameters: compileParameters(options.parameters) });

function cfgGet(config, key, fallback) {
  const v = config ? config[key] : undefined;
  if (v && typeof v === "object") {
    if (typeof v.get === "function") {
      try {
        const got = v.get();
        return got === undefined || got === null ? fallback : got;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
  return v === undefined || v === null ? fallback : v;
}

function safe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { ok: false, error: "输出无法序列化" };
  }
}

const TEXT_OUTPUT = {
  schema: { type: "object", properties: {}, additionalProperties: true },
  render: (_args, value) => [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
};

export const name = "plugin-checkup";
export const inject = ["tools"];

export const Config = !z
  ? undefined
  : z.object({
      profilesDir: z.string().default("").description("profiles 目录（空=~/.dsh/profiles）").extra("volatile", true),
      checkUpdates: z.boolean().default(true).description("是否查 npm 最新版本（需要联网）").extra("volatile", true),
      includeBuiltins: z.boolean().default(false).description("是否包含 @deepseek-ai/* 内置包").extra("volatile", true),
    });

export function apply(ctx, config) {
  const profilesDir = cfgGet(config, "profilesDir", "") || defaultProfilesDir();
  const checkUpdates = cfgGet(config, "checkUpdates", true) !== false;
  const includeBuiltins = cfgGet(config, "includeBuiltins", false) === true;

  const tool = (spec) =>
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters || {},
        output: TEXT_OUTPUT,
        async execute(args) {
          try {
            return safe(await spec.execute(args || {}));
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        },
      }),
    );

  const scan = () => scanProfiles(profilesDir, { includeBuiltins });

  tool({
    name: "plugin_list",
    description:
      "列出当前 DSH 各个 profile 里装了的插件（名称/版本/描述/安装方式/是否在 bundles/体积）。只读，用来回答「我装了什么」。",
    parameters: {
      profile: { type: "string", description: "只看某个 profile（可选，如 desktop / headless）" },
    },
    execute: ({ profile }) => {
      const { profiles, plugins } = scan();
      const list = profile ? plugins.filter((p) => p.profile === profile) : plugins;
      return {
        ok: true,
        profiles_scan: profiles,
        count: list.length,
        plugins: list.map((p) => ({
          name: p.name,
          version: p.version,
          profile: p.profile,
          kind: p.kind,
          bundled: p.bundled,
          sizeKB: p.sizeKB,
          description: (p.description || "").slice(0, 90),
        })),
      };
    },
  });

  tool({
    name: "plugin_checkup",
    description:
      "插件体检：按「治什么病」分类、找出重复能力（同类装了 3 个以上）、装了但没启用的插件、" +
      "体积 top5、可更新版本，并给建议。只读。",
    parameters: {},
    execute: async () => {
      const scanned = scan();
      const updates = checkUpdates ? await fetchLatestVersions(scanned.plugins) : {};
      return checkup(scanned, updates);
    },
  });

  tool({
    name: "plugin_why",
    description: "查某个已装插件的详情：版本、来源、安装方式、在哪些 profile 里、是否启用、体积。",
    parameters: {
      name: { type: "string", description: "插件名（支持部分匹配，如 whale）", required: true },
    },
    execute: ({ name }) => {
      const q = String(name || "").trim().toLowerCase();
      const { plugins } = scan();
      const hits = plugins.filter((p) => p.name.toLowerCase().includes(q));
      if (!hits.length) return { ok: true, count: 0, hint: `没找到名字包含「${name}」的插件` };
      return {
        ok: true,
        count: hits.length,
        matches: hits.map((p) => ({
          name: p.name,
          version: p.version,
          profile: p.profile,
          kind: p.kind,
          spec: p.spec,
          bundled: p.bundled,
          has_bundle_patch: p.hasBundlePatch,
          repository: p.repository || "",
          license: p.license || "",
          sizeKB: p.sizeKB,
          link_target: p.linkTarget,
        })),
      };
    },
  });

  ctx.logger?.info?.(`[plugin-checkup] 已加载，profiles: ${profilesDir}`);
}
