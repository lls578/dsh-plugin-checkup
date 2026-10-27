/**
 * 单元测试（不联网、不读真实 profile：用临时目录造假数据）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apply } from "../index.js";
import { classify, installKind, scanProfiles, checkup } from "../lib/inspect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "dsh-checkup-test-"));

function fakePlugin(profile, name, version, description, spec) {
  const dir = join(tmp, profile, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name, version, description, license: "MIT", repository: "https://github.com/x/" + name,
  }));
  writeFileSync(join(dir, "index.js"), "export const name = 'x';\n");
  return spec;
}

function fakeProfile(profile, deps, bundles) {
  mkdirSync(join(tmp, profile), { recursive: true });
  writeFileSync(join(tmp, profile, "package.json"), JSON.stringify({
    name: "dsh-profile-" + profile,
    dependencies: deps,
    dsh: { profile: { bundles } },
  }));
}

fakeProfile("a", {
  "dsh-memory-x": "link:../../x",
  "dsh-whale-widget": "^0.3.18",
  "dsh-wallpaper": "https://github.com/x/wallpaper.tar.gz",
}, ["dsh-memory-x", "dsh-whale-widget"]);
fakePlugin("a", "dsh-memory-x", "1.0.0", "记忆系统 extension", "link:../../x");
fakePlugin("a", "dsh-whale-widget", "0.3.18", "桌宠小鲸鱼", "^0.3.18");
fakePlugin("a", "dsh-wallpaper", "1.2.0", "壁纸引擎 theme", "https://github.com/x/wallpaper.tar.gz");

fakeProfile("b", { "dsh-theme-pack": "^1.0.0" }, ["dsh-theme-pack"]);
fakePlugin("b", "dsh-theme-pack", "1.0.0", "界面主题 UI pack", "^1.0.0");

// ── 纯函数断言 ──
if (installKind("link:../../x") !== "本地目录") throw new Error("installKind link wrong");
if (installKind("^1.2.3") !== "npm") throw new Error("installKind npm wrong");
if (installKind("https://github.com/x/y.tar.gz") !== "GitHub / URL") throw new Error("installKind url wrong");
if (classify({ name: "dsh-memory-x", description: "记忆系统" }).key !== "memory") throw new Error("classify memory wrong");
if (classify({ name: "dsh-wallpaper", description: "壁纸引擎 theme" }).key !== "ui") throw new Error("classify ui wrong");
if (classify({ name: "dsh-bili-scroll", description: "刷B站插件" }).key !== "bili") throw new Error("classify bili wrong");
console.log("[test] helper functions ok");

const scanned = scanProfiles(tmp);
if (scanned.profiles.length !== 2) throw new Error("profiles wrong: " + scanned.profiles.length);
if (scanned.plugins.length !== 4) throw new Error("plugins wrong: " + scanned.plugins.length);
const memo = scanned.plugins.find((p) => p.name === "dsh-memory-x");
if (!memo.bundled) throw new Error("memory should be bundled");
if (memo.kind !== "本地目录") throw new Error("memory kind wrong");
console.log("[test] scan ok:", scanned.plugins.map((p) => p.name).join(", "));

const result = checkup(scanned, { "dsh-whale-widget": "0.4.0" });
if (!result.ok) throw new Error("checkup failed");
if (!result.categories.length) throw new Error("no categories");
const uiCat = result.categories.find((c) => c.name.includes("界面"));
if (!uiCat) throw new Error("ui category missing: " + JSON.stringify(result.categories));
console.log("[test] categories:", result.categories.map((c) => `${c.name}×${c.count}`).join("、"));

const outdated = result.outdated.find((o) => o.name === "dsh-whale-widget");
if (!outdated || outdated.latest !== "0.4.0") throw new Error("outdated wrong: " + JSON.stringify(result.outdated));
console.log("[test] outdated ok:", JSON.stringify(outdated));

// ── 插件注册 ──
const tools = [];
const ctx = { tools: { register: (t) => (tools.push(t), t) }, logger: { info() {}, warn() {} } };
apply(ctx, { profilesDir: tmp, checkUpdates: false, includeBuiltins: false });
const names = tools.map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify(["plugin_checkup", "plugin_list", "plugin_why"])) {
  throw new Error("tools wrong: " + names.join(","));
}
console.log("[test] tools:", names.join(", "));

const list = await tools.find((t) => t.name === "plugin_list").execute({ profile: "a" });
if (!list.ok || list.count !== 3) throw new Error("plugin_list failed: " + JSON.stringify(list).slice(0, 200));
console.log("[test] plugin_list ok:", list.count);

const check = await tools.find((t) => t.name === "plugin_checkup").execute({});
if (!check.ok || check.plugins !== 4) throw new Error("plugin_checkup failed: " + JSON.stringify(check).slice(0, 200));
console.log("[test] plugin_checkup ok:", check.plugins, "plugins,", check.suggestions.length, "suggestions");

const why = await tools.find((t) => t.name === "plugin_why").execute({ name: "whale" });
if (!why.ok || why.count !== 1) throw new Error("plugin_why failed");
console.log("[test] plugin_why ok:", why.matches[0].name, why.matches[0].version);

rmSync(tmp, { recursive: true, force: true });
console.log("[test] ✅ all passed");
