# Changelog

## 0.1.0 (2026-10-27)

- 首个版本：`plugin_list` / `plugin_checkup` / `plugin_why`
- 扫描所有 profile：版本、描述、安装方式、是否在 bundles、体积、link 目标
- 按「治什么病」自动分类（11 类），重复能力 / 未启用 / 体积 / 更新提示
- 只读本地文件；查更新 best-effort，失败跳过
- 单元测试用临时目录造数据，不联网
