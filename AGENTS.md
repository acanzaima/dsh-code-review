# AGENTS.md

给在本仓库工作的 AI coding agent 的说明。开始改动前先读本文件，再读
[docs/development.md](docs/development.md) 与相关设计文档。用户文档见 [README.md](README.md)，
维护者文档索引见 [docs/README.md](docs/README.md)。

## 项目概览

`dsh-code-review` 是 DSH（DeepSeek Harness）Web UI 插件：在对话内的非模态浮动审阅窗口中查看、
暂存并提交当前对话所属 Git 仓库的未提交改动，同一页面可同时打开多个独立窗口。Host 半是 Cordis
插件（ESM、Node.js ≥ 20.11、零运行时依赖）；Client 半是单个生成的浏览器 bundle（普通脚本拼接，
React 由宿主模块表提供）。

源码布局、模块职责与构建/测试细节以 [docs/development.md](docs/development.md) 第 4 节为准；
协议、架构与 AI 归类分别见 [docs/protocol.md](docs/protocol.md)、
[docs/architecture.md](docs/architecture.md)、[docs/ai-grouping.md](docs/ai-grouping.md)。

## 硬性不变量

1. **零运行时依赖**：不新增 `dependencies` / `devDependencies`；Host 只用 Node 内置模块，Client
   只用宿主提供的 `react`。
2. **绝不手改 `client.js`**：改 `src/client/*.js` 后运行 `npm run build`；客户端源码是普通脚本
   （无 ESM/JSX/顶层 await，只能 `require` 同级模块或 `react`），构建顺序由
   `scripts/build.mjs` 的 `ORDER` 固定，不要改乱。
3. **样式只用 DSH 主题令牌**：不写字面色值；插件样式全部限定在 `.gr-` 命名空间。
4. **文案走 i18n**：所有可见文案同时存在于 zh / en 字典且 key 完全一致。
5. **协议变更要成套**：Host 方法表、`src/client/rpc.js` 封装、`docs/protocol.md` 与测试同一
   次改动内同步；错误码用 `<区域>/<原因>` 并在协议文档登记。
6. **Git 写操作安全**：写前重读 git 状态并校验指纹；所有写操作走同一条串行写链；永不 force
   push；只提交暂存区内容；还原（discard）必须先确认；git 只通过 argv 数组调用，不经过 shell。
7. **文档同步**：行为变化更新 `docs/` 与 `CHANGELOG.md` 的 `[Unreleased]`。`README` 面向用户，
   `docs/` 面向维护者，不要把实现细节混进用户教程。
8. **不在仓库内留临时文件**：测试临时仓库位于 `.tmp-test/`（已忽略），其余临时文件不要进仓库。

## 工作流程与完成标准

1. 读本文件、[docs/development.md](docs/development.md)，按改动类型补读对应设计文档。
2. 只改任务范围内的文件；不顺手重构无关代码，不修改生成产物或他人负责的文档。
3. 编辑源码；客户端源码变化时运行 `npm run build`。
4. 跑受影响的测试（如 `node --test test/diff.test.mjs`），跨层或协议改动跑全量 `npm test`。
5. 完成前运行 `npm run validate -- --with-tests`（= `npm run check`）并确保全部通过；不得为使
   检查通过而弱化测试或放宽校验。
6. 行为变化补测试、更新 `CHANGELOG.md` 与相关 `docs/` / `README`，确认没有新增依赖、绝对本地
   路径、密钥或隐私数据。
7. 按 Conventional Commits 写提交信息（`feat`/`fix`/`docs`/`test`/`refactor`/`chore`，祈使句）。
