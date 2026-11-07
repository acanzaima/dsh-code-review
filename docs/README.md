# dsh-code-review 文档

本目录是 `dsh-code-review` 的工程文档集合：插件由哪些部分组成、一次请求如何在 Host 与浏览器端之间流动、AI 归类具体发送什么数据，以及如何构建、校验和发布这个包。

**README 面向使用者，docs 面向维护者与集成者。** 安装、打开审阅窗口、日常审阅与提交操作请看仓库根目录的 [README](../README.md)；本目录不重复这些步骤，只解释背后的设计与约定。

## 阅读指引

| 读者 | 目标 | 文档 |
| --- | --- | --- |
| 使用者 | 安装插件、打开审阅窗口、完成暂存 / 还原 / 提交 / 推送，查阅快捷键 | [README](../README.md) |
| 维护者、集成者 | 理解 Host 与 Client 两半的分层、模块职责、插槽注册、写安全不变量与设计取舍 | [architecture.md](./architecture.md) |
| 协议实现者、集成者 | 查阅 Host–Client 方法表、数据形状、错误码、客户端 bundle 格式与模块边界 | [protocol.md](./protocol.md) |
| 使用者、维护者 | 了解 AI 归类的作用与边界、模型选择语义、发送的数据、隐私与失败回退 | [ai-grouping.md](./ai-grouping.md) |
| 贡献者 | 准备环境、理解源码布局与客户端源码规则、跑测试与校验、安装调试、发布 | [development.md](./development.md) |
| 贡献者 | 提交 Issue / Pull Request 的流程与规范 | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| 安全研究者、使用者 | 安全问题与漏洞的私密报告渠道 | [SECURITY.md](../SECURITY.md) |
| 使用者、维护者 | 每个版本的变更记录 | [CHANGELOG.md](../CHANGELOG.md) |

## 文档划分

`README.md`（以及英文版 `README.en.md`）是面向使用者的入口：它回答"这个插件能做什么、怎么装、怎么用、有哪些限制"。`docs/` 是面向维护者与集成者的参考手册：它回答"为什么这样实现、协议长什么样、改动时要注意什么"。

四个主题文档的分工如下：

- [architecture.md](./architecture.md)：整体结构与运行时视图，不展开方法级细节；需要协议细节时链接到 `protocol.md`。
- [protocol.md](./protocol.md)：Host–Client 通道的权威定义，方法名、参数、返回值、错误码与数据形状以这里为准。
- [ai-grouping.md](./ai-grouping.md)：唯一一项会把数据交给模型的特性，单独说明数据边界与失败语义。
- [development.md](./development.md)：本地开发、校验、安装调试与发布流程。

## 文档约定

- 文档用中文撰写，代码标识符、协议字段名、命令与文件路径保持英文。
- 所有相对链接都相对于本文件所在目录解析。
- `docs/` 随 GitHub 仓库发布，但不进入 npm 包：`package.json` 的 `files` 只包含运行时需要的文件（Host 源码、`client.js`、`cordis.patch.yml`、locale、`icon.svg`、`README.md` / `README.en.md` 与 `LICENSE`），测试、脚本、CI 配置与本目录都不随包发布。
- `docs/` 只放维护者 / 集成者文档；README 顶部简介图等用户向素材放在仓库根目录 `assets/`，不要混进本目录（若将来把 `docs/` 作为 GitHub Pages 根目录，两者也应保持分离）。
- 文档描述的是当前仓库中的实现；协议或行为变化时，相关文档与代码在同一次改动内更新。
