/**
 * 真实数据演示：node scripts/demo.mjs
 * 扫描本机 DSH profiles，输出插件清单 + 体检结果。
 */
import { defaultProfilesDir, scanProfiles, checkup } from "../lib/inspect.mjs";

const dir = process.argv[2] || defaultProfilesDir();
const { profiles, plugins } = scanProfiles(dir);
console.log("profiles:", profiles.join(", "), "| 插件数:", plugins.length);

const r = checkup({ profiles, plugins }, {});
console.log("\n=== 按「治什么病」分类 ===");
for (const c of r.categories) console.log(`${c.name}（${c.count}）: ${c.plugins.join("、")}`);
console.log("\n=== 体检 ===");
console.log("未启用:", r.not_bundled.join("、") || "无");
console.log("重复能力:", r.duplicates.map((d) => `${d.name}×${d.plugins.length}`).join("、") || "无");
console.log("体积 top5:", r.biggest.map((b) => `${b.name} ${b.sizeKB}KB`).join("、") || "无");
console.log("\n建议:");
for (const s of r.suggestions) console.log(" ·", s);
