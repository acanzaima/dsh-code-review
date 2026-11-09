# 贡献指南

感谢你愿意为 `dsh-code-review` 做出贡献。这是一个 DSH（DeepSeek Harness）Web UI 插件：
在对话内审阅、暂存并提交当前对话所属 Git 仓库的未提交改动。它刻意不是完整的 Git 客户端，
功能边界见 [README.md](README.md) 的「已知限制」一节。你可以通过以下方式参与：

- **报告问题**：通过仓库的 Issue 模板（`.github/ISSUE_TEMPLATE/`）提交，仓库已关闭空白 issue。
  请附上插件版本、DSH 版本、操作系统、复现步骤与期望/实际行为；有报错或截图也请一并提供。
- **提出功能**：先描述要解决的问题与使用场景，再讨论方案；超出项目定位的需求可能不会被接受。
- **改进文档**：README、`docs/` 中的错误、过时信息与歧义都值得提 PR。
- **贡献代码**：修 Bug、补测试、补边界处理，或实现已经讨论过的功能。

## 动手之前

1. 先在仓库的 Issues 与 Pull Requests 中搜索，避免重复。
2. 较大的改动（新功能、协议或数据形状变化、重构）请先开 issue 说明方案、影响面和替代方案，达成一致后再动手。
3. 一个 PR 只做一件事：把重构、格式化与行为变化分开，方便评审与回滚。

## 开发环境

- Node.js ≥ 20.11（`.nvmrc` 当前为 20）。
- 本机可用的 `git` 命令：测试会创建真实临时仓库并执行真实 git 操作。
- **不需要** `npm install`：项目没有任何依赖，也没有安装步骤。

建议先跑一遍基线命令，确认环境正常：

```bash
npm test            # node scripts/test.mjs（全部测试文件）
npm run validate    # 8 项快速发布门禁
npm run check       # 发布门禁 + 完整测试（= npm run validate -- --with-tests）
```

本仓库主要在 Windows 上开发与验证，其他平台的问题欢迎通过 Issue 反馈；提交 PR 前请在本地跑通 `npm run check`。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `src/host/` | Cordis 插件（Host 半）：路由、会话/仓库解析、git 操作、AI 归类、设置 |
| `src/client/` | 浏览器端源码，按固定顺序拼接为 `client.js` |
| `client.js` | 构建产物，提交进仓库并随包发布，**禁止手改** |
| `scripts/` | `build`、`validate`、`pack-check`、`release`、`test` 工具 |
| `test/` | Node 内置测试运行器；`test/helpers/repo.mjs` 负责搭建临时仓库 |
| `docs/` | 架构、协议、AI 归类与开发文档，索引见 [docs/README.md](docs/README.md) |
| `assets/` | README 顶部简介图等用户向素材（不随包发布） |
| `locale/` | zh / en 界面元数据 |
| `index.js`、`cordis.patch.yml` | Host 入口与 Cordis bundle patch |
| `.github/` | CI 与 Issue 模板 |

分层与数据流见 [docs/architecture.md](docs/architecture.md)，本地开发细节见
[docs/development.md](docs/development.md)，Host 与 Client 的通信契约见
[docs/protocol.md](docs/protocol.md)。[README.md](README.md) 与 [README.en.md](README.en.md)
面向用户，`docs/` 面向维护者，[AGENTS.md](AGENTS.md) 面向在本仓库工作的 AI coding agent。

## 改动流程

1. 从 `main` 开一个主题分支，命名为 `feat/...`、`fix/...` 或 `docs/...`。
2. 修改源码；客户端改动只改 `src/client/*.js`。
3. 客户端源码有改动时运行 `npm run build`，重新生成 `client.js` 并一起提交。
4. 运行测试，例如 `npm test`，或只跑受影响的文件：`node --test test/diff.test.mjs`。
5. 完成前运行 `npm run check`，必须全部通过。CI 会运行 `npm test` 与 `npm run validate`，
   并检查打包文件列表，本地结果应与之一致。
6. 用户可见的行为变化要写入 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]`；文档受影响时同步更新 `README.md` 或 `docs/`。
7. 提交 PR，逐项确认下面的清单。

## 编码约定与硬性约束

以下规则由构建流程或 `npm run validate` 强制，评审时也不会放宽：

- **零运行时依赖**：`dependencies` 与 `devDependencies` 必须保持为空；Host 只使用 Node 内置模块，Client 只使用宿主注入的 `react`。
- **不要手改 `client.js`**：它是 `scripts/build.mjs` 的确定性输出，改源码后重新构建。
- **客户端源码是普通脚本**：没有 ESM `import`/`export`、没有 JSX、没有顶层 `await`；同级模块只能通过 `require('模块名')` 引用。
- **构建顺序固定**：`util → i18n → state → rpc → diff → diff-view → styles → components → app`，由 `scripts/build.mjs` 的 `ORDER` 决定，不要改动拼接逻辑。
- **样式只用主题令牌**：客户端样式只能使用 `--dsw-alias-*` 等 DSH 主题自定义属性及由其派生的透明叠加，不得出现字面颜色值；插件样式全部限定在 `.gr-` 命名空间。
- **文案走 i18n**：所有可见文案必须同时存在于 zh 与 en 字典，且 key 完全一致；不要在组件里硬编码中英文。
- **协议变更要成套**：新增或修改 Host 方法时，同步更新 Host 方法表、[docs/protocol.md](docs/protocol.md)、Client 的 RPC 层与测试。
- **保持安全不变量**：所有写操作前重新读取 git 状态并校验指纹；同一时间只有一条写入链；永不 force push；只提交暂存区内容；还原（discard）必须先确认。
- **不用 shell 执行 git**：git 调用只能通过 argv 数组传入，不得拼接字符串后交给 shell。
- **不在仓库里造临时文件**：测试的临时仓库位于 `.tmp-test/`（已被忽略）；除此之外不要在仓库中留临时文件。

## 提交信息

使用 Conventional Commits：`type(scope): summary`。

- `type` 取 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`；`scope` 可选，例如 `host`、`client`、`diff`。
- `summary` 用祈使句、简短具体；中英文均可，但同一个 PR 内保持一致。
- 破坏性变更在 type 后加 `!`，或在正文末尾写 `BREAKING CHANGE: ...`；正文解释「为什么」，不要复述 diff。示例：`fix(host): abort hunk staging when the fingerprint changed`。

## Pull Request 检查清单

- [ ] 改动聚焦，一个 PR 解决一个问题。
- [ ] 新增或修改的行为有对应测试，`npm test` 通过。
- [ ] 客户端源码改动已重新构建，`client.js` 与源码一致。
- [ ] `npm run check` 通过。
- [ ] 用户可见变化已写入 `CHANGELOG.md`，相关文档已更新。
- [ ] 没有新增运行时依赖、绝对本地路径、密钥或隐私数据，也没有手改生成文件（如 `client.js`）。
- [ ] 提交信息符合上面的约定。
- [ ] 既有安全不变量保持不变；如果确实要调整，请在 PR 中说明理由和风险。

维护者会尽快查看 PR，但本项目由志愿者维护，不承诺固定时限。评审关注正确性、安全边界、测试覆盖与长期可维护性；请作者主动跟进意见并保持 PR 更新。功能是否合入以项目定位为准，维护者可能拒绝超出范围的改动。

## 发布（维护者）

发布由维护者执行，流水线依次为：校验 → 测试 → 构建 → 打包 → 认证 → 版本检查 → `npm publish`
（npm 包为 scoped 公共包 `@acanzaima/dsh-code-review`）。

- **自动发布（默认）**：更新 [CHANGELOG.md](CHANGELOG.md) 与 `package.json` 的版本号并提交到
  `main` 后，创建并推送 `v<version>` tag（本地 `git tag v0.2.1 && git push origin v0.2.1`，
  或在 GitHub 页面创建同名 tag）。`.github/workflows/publish.yml` 会校验 tag 与版本一致并执行
  完整发布流水线；发布走 npm Trusted Publishing（OIDC），仓库不需要 `NPM_TOKEN` 之类的长期
  token。`0.x.y-rc.n` 这类预发布版本自动发到 `next` dist-tag 而不是 `latest`。
- **本地发布**：先 `npm login`（账号已启用 2FA，需要验证码），再跑
  `npm run release -- --dry-run` 确认，最后执行 `npm run release`。两种方式共用同一脚本；同一
  版本不能重复发布。

所有参与者请遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](SECURITY.md)
私下报告，不要开公开 issue。项目使用 MIT 许可证，见 [LICENSE](LICENSE)。
