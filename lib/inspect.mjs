/**
 * DSH 插件体检核心：扫描 profile → 读已装插件 → 分类 / 查重 / 检查更新。
 * 只读本地文件，不改任何东西。
 */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CATEGORIES = [
  { key: "bili", name: "B站 / 内容运营", re: /(bilibili|b站|up主|创作|评论|弹幕|刷站|养鱼)/i },
  { key: "memory", name: "记忆 / 上下文", re: /(memory|记忆|context|上下文|recall|压缩)/i },
  { key: "voice", name: "语音 / 字幕", re: /(voice|语音|tts|字幕|subtitle|asr|transcri|音频)/i },
  { key: "ui", name: "界面 / 主题 / 桌宠", re: /(ui|theme|壁纸|wallpaper|桌宠|pet|widget|whale|皮肤|侧栏|sidebar|界面)/i },
  { key: "remote", name: "远程 / 连接", re: /(remote|mobile|手机|飞书|telegram|微信|qq|bridge|连接|network|网络|proxy|代理)/i },
  { key: "media", name: "媒体 / 下载", re: /(download|下载|媒体|media|audio|video|yt-dlp|图片|image)/i },
  { key: "plugin", name: "插件管理 / 市场", re: /(plugin|插件|market|update|更新|manager|管理)/i },
  { key: "safety", name: "安全 / 沙箱", re: /(safety|安全|sandbox|沙箱|permission|权限|guard|防护)/i },
  { key: "session", name: "会话 / 进度 / 任务", re: /(session|会话|progress|进度|task|任务|agent|team|reconnect)/i },
  { key: "search", name: "搜索 / 网络工具", re: /(search|搜索|fetch|web|爬)/i },
  { key: "model", name: "模型 / 推理", re: /(model|模型|llm|deepseek|推理|token|余额)/i },
  { key: "other", name: "其他", re: /[\s\S]*/ },
];

export function defaultProfilesDir() {
  return join(process.env.USERPROFILE || homedir(), ".dsh", "profiles");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function dirSizeKB(dir, cap = 1200) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < cap) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules") continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          /* skip */
        }
        files++;
        if (files >= cap) break;
      }
    }
  }
  return Math.round(total / 1024);
}

export function installKind(spec) {
  const s = String(spec || "");
  if (s.startsWith("link:") || s.startsWith("file:")) return "本地目录";
  if (/^https?:/.test(s)) return "GitHub / URL";
  if (s.startsWith("git")) return "git";
  if (/^[\^~]?\d/.test(s) || s === "*" || s === "latest") return "npm";
  return "其他";
}

export function classify(plugin) {
  const bili = CATEGORIES[0];
  if (/(^|[^a-z])bili([^a-z]|$)/i.test(String(plugin.name || ""))) return bili;
  const text = `${plugin.name} ${plugin.description || ""}`;
  for (const c of CATEGORIES) if (c.re.test(text)) return c;
  return CATEGORIES[CATEGORIES.length - 1];
}

/** 扫描所有 profile 的已装插件。 */
export function scanProfiles(profilesDir, { includeBuiltins = false } = {}) {
  if (!existsSync(profilesDir)) throw new Error(`profiles 目录不存在：${profilesDir}`);
  const plugins = [];
  const profiles = [];
  for (const name of readdirSync(profilesDir)) {
    const dir = join(profilesDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg) continue;
    profiles.push(name);
    const deps = pkg.dependencies || {};
    const bundles = pkg.dsh?.profile?.bundles || [];
    for (const [dep, spec] of Object.entries(deps)) {
      if (!includeBuiltins && dep.startsWith("@deepseek-ai/")) continue;
      const pdir = join(dir, "node_modules", dep);
      const meta = readJson(join(pdir, "package.json"));
      if (!meta) continue;
      let linkTarget = null;
      try {
        if (lstatSync(pdir).isSymbolicLink()) linkTarget = readlinkSync(pdir);
      } catch {
        /* skip */
      }
      plugins.push({
        profile: name,
        name: dep,
        version: meta.version || "",
        description: meta.description || "",
        license: meta.license || "",
        repository: typeof meta.repository === "string" ? meta.repository : meta.repository?.url || "",
        spec,
        kind: installKind(spec),
        bundled: bundles.includes(dep),
        hasBundlePatch: Boolean(meta.dsh?.bundle),
        linkTarget,
        sizeKB: linkTarget ? null : dirSizeKB(pdir),
      });
    }
  }
  return { profiles, plugins };
}

/** 体检：分类、查重、未启用、体积、更新。 */
export function checkup({ profiles, plugins }, updates = {}) {
  // 跨 profile 去重：同一个插件装在多个 profile 只算一次
  const byName = new Map();
  for (const p of plugins) {
    if (!byName.has(p.name)) {
      byName.set(p.name, { ...p, profiles: [p.profile], bundled_any: Boolean(p.bundled) });
    } else {
      const cur = byName.get(p.name);
      cur.profiles.push(p.profile);
      cur.bundled_any = cur.bundled_any || Boolean(p.bundled);
      if (typeof p.sizeKB === "number" && (cur.sizeKB == null || p.sizeKB > cur.sizeKB)) cur.sizeKB = p.sizeKB;
    }
  }
  const uniq = [...byName.values()];

  const cats = new Map();
  for (const p of uniq) {
    const c = classify(p);
    if (!cats.has(c.key)) cats.set(c.key, { key: c.key, name: c.name, plugins: [] });
    cats.get(c.key).plugins.push(p.name);
  }
  const categories = [...cats.values()].sort((a, b) => b.plugins.length - a.plugins.length);
  const duplicates = categories.filter((c) => c.plugins.length >= 3 && c.key !== "other");

  const notBundled = uniq.filter((p) => !p.bundled_any);
  const biggest = [...uniq]
    .filter((p) => typeof p.sizeKB === "number")
    .sort((a, b) => b.sizeKB - a.sizeKB)
    .slice(0, 5)
    .map((p) => ({ name: p.name, sizeKB: p.sizeKB }));

  const outdated = [];
  for (const p of uniq) {
    const latest = updates[p.name];
    if (!latest || !p.version) continue;
    if (latest !== p.version) outdated.push({ name: p.name, current: p.version, latest });
  }

  const suggestions = [];
  if (duplicates.length) {
    suggestions.push(
      `有 ${duplicates.length} 类能力装了 3 个以上（${duplicates.map((d) => `${d.name}×${d.plugins.length}`).join("、")}），考虑留最顺手的 1-2 个。`,
    );
  }
  if (notBundled.length) {
    suggestions.push(`有 ${notBundled.length} 个插件装了但不在 bundles 里（不会加载）：${notBundled.map((p) => p.name).join("、")}。`);
  }
  if (outdated.length) {
    suggestions.push(`有 ${outdated.length} 个插件有新版本：${outdated.map((o) => `${o.name} ${o.current}→${o.latest}`).join("；")}。`);
  }
  if (!suggestions.length) suggestions.push("体检通过：没有明显重复、没有装了没启用的插件。");

  return {
    ok: true,
    profiles: profiles.length,
    profile_names: profiles,
    plugins: uniq.length,
    plugins_total: plugins.length,
    categories: categories.map((c) => ({ name: c.name, count: c.plugins.length, plugins: c.plugins })),
    duplicates: duplicates.map((d) => ({ name: d.name, plugins: d.plugins })),
    not_bundled: notBundled.map((p) => p.name),
    biggest,
    outdated,
    suggestions,
  };
}

/** 查 npm registry 最新版本（best-effort，失败跳过）。 */
export async function fetchLatestVersions(plugins, { timeoutMs = 5000 } = {}) {
  const names = [...new Set(plugins.filter((p) => p.kind === "npm" && !p.name.startsWith("@deepseek-ai/")).map((p) => p.name))];
  const out = {};
  await Promise.allSettled(
    names.map(async (name) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
          headers: { "User-Agent": "dsh-plugin-checkup/0.1" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return;
        const j = await res.json();
        if (j?.version) out[name] = j.version;
      } catch {
        /* 跳过 */
      }
    }),
  );
  return out;
}
