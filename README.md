<p align="center">
  <img src="icon.svg" width="72" height="72" alt="dsh-code-review icon">
</p>

<h1 align="center">dsh-code-review</h1>

<p align="center">在 DSH Web UI 中通过非模态浮动窗口审阅、暂存并提交当前对话所属 Git 仓库的未提交改动。</p>

<p align="center">
  <b>中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Node.js 20.11 或更高版本" src="https://img.shields.io/badge/node-%3E%3D20.11-339933?style=flat-square">
  <img alt="DSH 0.2.2-rc.1" src="https://img.shields.io/badge/DSH-0.2.2--rc.1-5b6ee1?style=flat-square">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square">
</p>

<p align="center">
  <img src="assets/cover.zh.png" alt="dsh-code-review 入口与界面示意：从 DSH 对话输入框工具行打开 Code Review，在浮动窗口中并排审阅改动、勾选暂存并提交" width="100%">
</p>

## 功能

- **并排审阅**：查看文件差异、语法高亮和增删统计，快速跳转变更位置。
- **选择提交内容**：按文件或分组暂存、取消暂存，也支持单个变更块操作与未暂存改动的还原。
- **提交与推送**：填写或让 AI 草拟提交信息，预览并推送到远程仓库，也可配置远程地址。
- **灵活的窗口**：支持多工作区 / 多会话独立审阅，窗口可拖动、缩放和最小化，不阻塞对话；适配 DSH 浅色 / 深色主题，提供中英双语。
- **可选 AI 归类**：按文件职能或功能逻辑组织改动，方便分组审阅与提交。

## 安装

插件发布在 npm（[`@acanzaima/dsh-code-review`](https://www.npmjs.com/package/@acanzaima/dsh-code-review)），在 DSH 的「插件」页中安装。运行需要本机可用的 Git 和 Node.js ≥ 20.11（DSH 桌面端已内置满足要求的运行时）；已在 DSH 0.2.2-rc.1 上验证。

### 通过 DSH 桌面端安装（推荐）

1. 打开 DSH 桌面端，在侧栏选择**插件**。
2. 点击**添加插件**，在「包名或地址」中填入 `@acanzaima/dsh-code-review`，点击**安装**。
3. 安装完成后点击**立即启用**；如果当时关掉了对话框，也可以在**已安装插件**中打开该插件的开关。
4. 回到对话，输入框工具行出现「打开 Code Review」即安装成功。若没有出现，重启一次 DSH。

### 从源码安装

适合跟进最新改动或排查问题。源码已包含构建好的客户端文件，不需要安装依赖，也不需要自行构建。

- 克隆仓库：`git clone https://github.com/acanzaima/dsh-code-review.git`。
- 从 [Releases 页面](https://github.com/acanzaima/dsh-code-review/releases) 下载对应版本的 **Source code (zip)** 并解压。

然后在插件页点击**添加插件**，填入克隆目录或解压目录的完整绝对路径（包含 `package.json` 的那一层），点击**安装**，再按上面的步骤启用。

升级、停用与卸载都在插件页完成；升级时先卸载旧版，再安装新版。

## 使用

1. 在 Git 项目对应的 DSH 对话中，点击输入框下方工具行里的 Code Review 图标（悬停提示「打开 Code Review」，位置见上方封面）。
2. 选择左侧文件查看差异，可搜索文件或跳转到上一处 / 下一处变更。
3. 勾选文件或分组，将改动加入暂存区；取消勾选会移出暂存区，保留文件内容。列表顶部的全选只作用于当前筛选结果。
4. 展开底部提交区，填写提交信息并提交；需要同步到远程时，再点击「推送」。提交按钮左侧的 sparkles 图标可按已暂存改动**用 AI 草拟提交信息**，草稿会写进输入框，确认或修改后照常提交。

右键文件或 diff 中的变更块，可执行暂存、取消暂存或还原。**还原会丢弃未暂存的改动，执行前需要确认，且无法撤销。**

窗口内按 `?` 查看快捷键。`Esc` 关闭菜单或对话框，审阅窗口通过标题栏的关闭按钮关闭。

### 多工作区与最小化

- **独立审阅**：在不同工作区或会话中分别打开 Code Review，可同时保留多个审阅窗口。每个窗口始终对应打开时的仓库，文件选择与差异查看互不影响；切换工作区或会话不会关闭已有窗口，也不会把它切换到另一个仓库。
- **收起与恢复**：点击标题栏的「最小化」，窗口收起为一条带仓库名的标题条，方便同时保留多个项目并继续对话。点击标题条右侧的向上箭头即可恢复原窗口。

各窗口的审阅界面状态独立；插件设置及同一仓库的 Git 状态仍共享。窗口只保留在当前页面中，刷新 DSH 页面会关闭所有审阅窗口。

## AI 能力

### AI 归类

默认按 Git 状态分组，也可在工具栏切换到：

- **按职能**：按公共组件、业务功能、配置、测试、文档等角色分组。
- **按功能逻辑**：把同一功能涉及的改动放在一起，纯配置、构建或文档等归入「非功能变更」。

AI 归类默认关闭，只整理文件列表。模型默认跟随当前会话，也可在窗口的设置中单独选择；归类失败时仍可按 Git 状态正常审阅。

归类会通过 DSH 的模型服务发送项目线索、变更路径等元数据，以及少量未跟踪文本文件的内容摘录。插件不收集遥测或保存 API 密钥；涉密项目建议保持 AI 归类关闭。可选的「会话空闲时预归类」也默认关闭，开启后可能在窗口未打开时消耗模型 token。数据范围与配置详见 [AI 归类说明](docs/ai-grouping.md)。

### AI 生成提交信息

提交区提交按钮左侧的 sparkles 图标可按已暂存改动草拟提交信息：优先沿用仓库历史提交的格式（type / scope、语言、正文分项），仓库还没有历史时使用社区通用的 `type(scope): 摘要`。草稿只写进可编辑的提交信息框，不会自动提交；没有可用模型或生成失败时提示原因，仍可手动填写。

这个动作只在点击时运行，会把**已暂存改动的 diff** 与最近提交的标题发送给模型（与只发元数据的归类不同），未暂存内容不会发送；涉密项目请自行判断是否使用。详见 [AI 生成提交信息说明](docs/ai-commit-message.md)。

## 使用限制

- 提交历史、分支切换、stash、rebase 等操作需使用其他 Git 工具；冲突也需在外部解决后刷新。
- 二进制文件不提供逐行 diff，部分文件类型不支持按变更块操作，界面会说明原因。
- 只提交暂存区内容，推送不会强制覆盖远端；推送预览不自动获取远程更新，需要时请先自行 `git fetch`。
- 变更列表过大时会截断，并禁用全选与提交；请缩小改动范围或使用命令行。
- AI 生成的提交信息只是草稿，只覆盖已暂存改动；发送前请确认内容，涉密改动建议手动填写。

## 文档与反馈

欢迎提交 Issue 与 Pull Request。开发和贡献请看 [开发指南](docs/development.md) 与 [贡献说明](CONTRIBUTING.md)，更多设计文档见 [文档索引](docs/README.md)，版本变化见 [更新日志](CHANGELOG.md)。参与社区请遵守 [行为准则](CODE_OF_CONDUCT.md)，安全问题请按 [安全说明](SECURITY.md) 报告。

## 第三方图标

界面图标来自 [Lucide](https://lucide.dev)，采用 ISC 许可证；其中源自 Feather 的图标采用 MIT 许可证。版权声明与许可证全文见 [LICENSE](LICENSE)。

## 许可证

[MIT License](LICENSE)，版权归 2026 dsh-code-review contributors 所有。
