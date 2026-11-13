# 开发与发布

本文面向贡献者：如何准备环境、理解源码布局与客户端源码规则、运行测试与校验、在本机 DSH 中安装调试，以及发布流程。使用者操作说明见 [README](../README.md)，协议细节见 [protocol.md](./protocol.md)。

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 20.11（`package.json` 的 `engines`）；CI 覆盖 Node 20 与 22 |
| Git | 本机可用的 `git` 命令；测试会创建真实临时仓库 |
| DSH | 0.2.2-rc.1（`@deepseek-ai/dsh`，当前开发与验证版本；早期版本针对 0.2.1-rc.5 编写），仅在需要活体验证界面 / 插槽时使用 |
| 操作系统 | 目标平台为 Windows / macOS / Linux，脚本只使用 Node 内置模块；当前验证环境为 Windows + Git for Windows |

## 2. 零依赖：没有安装步骤

`package.json` 没有 `dependencies` / `devDependencies`，Host 与 Client 都只使用 Node 内置模块和宿主提供的 React。因此不需要 `npm install`，克隆仓库后直接跑脚本；`client.js` 已提交进仓库，构建只在修改 `src/client/` 后需要；发布包不包含构建步骤，安装后即可使用。

## 3. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 由 `src/client/*.js` 重新生成 `client.js`；输出字节确定 |
| `npm run build -- --check` | 只检查产物是否最新，不写文件 |
| `npm test` | 通过 `scripts/test.mjs` 用 Node 内置测试运行器跑全部测试 |
| `npm run validate` | 8 项发布前校验，失败即停并指出门禁名 |
| `npm run validate -- --with-tests` | 先跑校验，再跑完整测试 |
| `npm run check` | 等价于上一行（`validate --with-tests`） |
| `npm run pack:check` | 用 `npm pack --dry-run --json` 断言发布文件列表与白名单一致 |
| `npm run release` | 有序发布流水线；`-- --dry-run` 只做本地步骤 |

`npm test`、`validate --with-tests` 与 `release` 都通过 `scripts/test.mjs` 这个单一入口跑测试：它用 `readdirSync('test')` 枚举 `*.test.mjs` 再显式传给 `node --test`，不依赖 Node 21+ 的原生 glob 展开，因此声明的最低版本 Node 20.11 可用。

每个脚本都可以直接调用对应文件（例如 `node scripts/build.mjs --check`），日志一致。

## 4. 源码布局与构建顺序

Host 半（ESM，Node builtins）：

| 文件 | 内容 |
| --- | --- |
| `src/host/index.js` | Cordis 入口、组合根、方法表与分发、仓库解析、写串行化、路由注册、空闲预归类调度 |
| `src/host/protocol.js` | 错误类型、响应封套、请求参数读取与规范化 |
| `src/host/models.js` | 模型目录、归类路由解析与显示标签 |
| `src/host/ai.js` | 归类提示词（按职能 / 按功能逻辑）与提交信息提示词、负载构造、`llm.stream` 调用、回复解析（含 `NON_FUNCTIONAL` → `kind` 映射与提交信息纯文本整理） |
| `src/host/git.js` | Git 调用引擎、状态 / diff / 写操作 / 提交 / 推送 / 远程配置、提交信息输入（最近提交 + 暂存 patch） |
| `src/host/patch.js` | 统一 diff 解析与单 hunk 补丁构造 |
| `src/host/settings.js` | 设置持久化（原子写） |

Client 半（普通脚本，由 `scripts/build.mjs` 按固定顺序拼接）：`util → i18n → state → rpc → open-in-app → diff → diff-view → styles → ui → components → app`。`app` 必须是最后一个模块：它导出 `apply` 与 `inject: ['slots']`，是 bundle 工厂的返回值。

构建步骤：按 `ORDER` 读取每个 `src/client/<name>.js`；逐文件静态检查（见下一节），失败时指出 `文件:行号`；把行尾归一化、保证单个结尾换行的源码按顺序拼进 `window.__ModuleLoader__.load` 的工厂函数；与现有 `client.js` 逐字节比较，一致则不动，不一致则重写，`--check` 模式只报告不写。

`client.js` 是提交进仓库的构建产物，**禁止手改**。修改 `src/client/` 后必须重新构建并一起提交；`npm run validate` 的 `client-build` 门禁会逐字节检查新鲜度。

## 5. 客户端源码规则

这些规则由 `scripts/build.mjs`（构建时）和 `scripts/validate.mjs`（校验时）共同强制：

| 规则 | 原因 |
| --- | --- |
| 文件在注释后必须以 `__def('<name>', function (exports, require, React) { ... })` 开头 | 拼接后的模块注册依赖这个名字与参数列表 |
| 纯脚本：不允许 `import` / `export`、JSX、顶层 `await` | 产物是拼接进单个工厂函数的脚本，不是 ESM 模块 |
| 只能 `require()` 构建顺序中的模块名或 `'react'` | 模块表只提供这些名字；其它 require 在浏览器中必然失败 |
| 不允许写 `document.body` | 插件只在自己的插槽组件树内渲染；`window` / `document` 级监听（键盘、可见性）允许，但必须在卸载时清理 |
| 样式只使用 DSH 主题 CSS 自定义属性 | 保证跟随浅色 / 深色主题；校验会拒绝字面颜色（含 `rgb()` / `rgba()` / hex），颜色透明度用 `color-mix()` 从 token 派生，阴影用 `--dsw-shadow-lv*` |
| 所有可见字符串走 `src/client/i18n.js` 的 zh / en 字典 | 窗口语言可在设置中切换；用户可见错误通过协议错误码表达 |

## 6. 修改 UI 样式

- 基础元素统一由 `src/client/ui.js` 提供：按钮 / 图标按钮 / 链接按钮 / 开关 / 选择器 / 输入框 / 文本域 / 对话框 / 键帽 / 徽标 / 标签 / 搜索框 / 复选框，以及设置页的 Section / Row / Hint 布局原语。`components.js` 只负责组合它们；要调整控件的尺寸或状态，改 `ui.js` + `styles.js` 一处即可。
- 按钮变体参考 DSH 客户端的基础按钮（`_button_*` 规则）：`default` 是 outline（hairline 内阴影），`primary` 是实心（`--dsw-alias-button-primary-fill` / `-hover`，文字用 `--dsw-alias-label-primary-foreground`），`ghost` / `danger` 同理。hover 必须写在具体变体上，不要写与变体无关的 `.gr-btn:hover`，否则会盖掉实心按钮的填充色、让前景文字失去对比度。列表行、菜单项、分组标题、搜索清除、hunk 展开等专用控件保留原生元素，不套用通用按钮。
- 图标统一内联在 `components.js` 的 `ICON_PARTS`（开发阶段从 Iconify 取 Lucide 的 SVG geometry，运行时不联网、不加依赖）。新增图标请沿用同一来源与 `currentColor` 描边，不要引入图标字体或远程 URL。「重新归类」固定用 `layers` 图层图标、刷新固定用循环箭头（`refresh`），两个动作不要共用同一个图标。
- 审阅窗口的外壳类名统一使用 `.gr-window*` 前缀：全帧窗口层负责定位与堆叠，窗口本体负责边界、圆角与阴影，标题栏（同时是拖拽区）、内容区与右侧 / 底部 / 边角的缩放把手都是这个前缀下的部件。窗口层顶部用 `top: var(--dsh-frame-top-clearance, 0px)` 让出 DSH 自己的窗口标题条（Windows / macOS 桌面端），`app.js` 的 `viewportSize()` 从 `innerHeight` 里减去同一个 token，因此窗口的“工作区”就是标题条下方的内容区：拖拽四边受限、不会被拖到标题栏下方或窗口外，最大化会铺满整个内容区。最小化后窗口只剩标题条，拖动按标题条的实际高度计算可拖范围（`clampMinimizedWindowRect`），可以一直拖到内容区底部；还原时按完整窗口尺寸重新钳制，最小化状态下不显示缩放手柄。窗口圆角跟随 DSH 窗口内容半径（`--dsh-windows-content-radius`，回退 `--dsw-radius-lg`），不要用 `--dsw-radius-panel` —— 那是 DSH 对话框 / 卡片的 28px 圆角，会让浮动窗口看起来像弹窗。窗口打开时默认占工作区的 85%（`WINDOW_DEFAULT_RATIO`，受最小尺寸与视口边距钳制）。窗口标题是仓库身份（`ReviewTitle`：图标 + 项目名，tooltip 为完整仓库路径）；标题栏右侧依次是「打开项目」split 控件（由窗口内容把渲染好的元素上报给窗口外壳，因为它需要仓库快照）、最小化、最大化 / 还原与关闭按钮。窗口内的 `.gr-panel-body` 不再自带边框与圆角，工作区边界由窗口外壳提供。审阅窗口本身**不使用**全页遮罩或焦点陷阱——只有窗口内对话框用 `.gr-modal-backdrop-scoped` 覆盖所在窗口并捕获焦点；窗口几何（位置与尺寸）由 `app.js` 按实时工作区钳制，拖动 / 缩放时窗口不会被移出可见区域。文件导航使用文件名 / 目录两行层级，diff 比较来源独立放在与代码列对齐的 `.gr-diff-sources`。比较来源只在展示层本地化，Host 标签与协议不变。工具栏在窄窗口自动换行为两行：分支 / 摘要 / AI 状态留在第一行，操作区（分组选择器 / 重新归类 / 刷新 / AI·提交并推送 / 推送 / 设置 / 快捷键）落到第二行；文件导航标题固定单行；diff 头部在窄列时把路径与变更导航拆成两行。工具栏的分组方式是 `ui.Select` 的三选一下拉（Git 状态 / AI 归类 · 按职能 / AI 归类 · 按功能逻辑），使用 `anchorMenu` 把 listbox 绝对定位在触发根节点内；`.gr-topbar` 是尺寸容器且设置了 `overflow: visible` 以容纳该下拉，不能退回 fixed 定位。提交方式选择（split 控件）与 `commitMode` 在底部提交抽屉内；工具栏只有独立的「AI·提交并推送」一键动作（见下一节）。新增/调整响应式规则时优先用 `@container gr-topbar` / `@container gr-files` / `@container gr-diff`，不要用视口媒体查询（窗口宽度与浏览器视口宽度无关）。
- 底部状态栏是常驻的（`StatusBar` / `.gr-statusbar`）：仓库状态可读时一直显示，左侧 `busy` / `error` / `notice` /「就绪」，右侧仓库摘要；就绪点 tooltip 用 `status.generatedAt` 格式化成本地时间；`app.js` 把 `refreshError` / `operationError` 作为状态栏 `error` 传入（原先单独的刷新错误条已并入这里）。宽度适配用 `@container gr-statusbar`：先隐藏未跟踪 / 冲突（`gr-statusbar-extra`），再收起整个摘要；不要把状态栏做成只在忙碌 / 错误 / 通知时出现。
- 工具栏左侧的分支 chip 是信息 + 动作 popover（`branchMenuItems`）：展示 `RepoRef` 的 HEAD 短 SHA / 上游 / 领先落后，复制分支名与仓库路径（`app.js` 的 `copyText`，成功后以 notice 回到状态栏）；「设置远程仓库…」经 `onSetRemote` 打开 `RemoteDialog`，提交时调用 `remoteSet`（本地 Git 配置写入，协议见 [protocol.md](./protocol.md)）。它不切换分支。**分支 popover 必须渲染在 `.gr-topbar` 子树之外**（`TopBar` 返回 `header` + `ContextMenu` 组成的 Fragment）：`.gr-topbar` 设置了 `container-type: inline-size`，`position: fixed` 的后代会被这个尺寸容器包含 / 裁剪，而不是相对视口定位。新增菜单应沿用 `ContextMenu` 的 `ignoreRef`（传入触发按钮 ref），否则点击触发器会先被外部关闭、再被 toggle 打开（“关了又开”）。工具栏内的分组选择器则使用 `ui.Select` 的 `anchorMenu`（绝对定位在触发根节点内），因为它必须贴着工具栏触发按钮展开，而 fixed 定位会被尺寸容器包含 / 裁剪。
- diff 头部的变更计数用 `diff.changePosition` 显示紧凑的「n / m」，完整文案 `diff.changeCounter` 放在 `title` 与 `.gr-sr-only` 中；两处都要保留，不要把完整文案只留在可见文本或只留在 tooltip 里。
- 文件导航标题行的三态全选（`FileNav`）：作用域来自 `groups` prop（`app.js` 传入搜索过滤后的 `visibleGroups`，无搜索时即全部条目），统计时排除 `conflict`；`allStaged` / `someStaged` 映射勾选 / 半选，`selectAllDisabledReason` 处理截断 / 忙碌，无条目时默认给出原因；点击回调是 `app.js` 的 `toggleGroupStaged`（勾选只 stage 未暂存项、取消勾选只 unstage 已暂存项），复用同一套 `stage` / `unstage` 指纹校验。**工具栏不再有「暂存全部 / 取消暂存全部」的 +/− 按钮**，批量暂存能力只走这条勾选入口，不要重新加回。
- 文件导航标题行分左右两组：左侧是标题与文件数（`.gr-files-title` / `.gr-files-count`），右侧 `.gr-files-head-right`（`margin-left: auto`）同组容纳批量控件 `.gr-files-bulk`（快速定位 / 全部展开 / 全部收起）；不要再往右簇加「已审阅」进度之类的控件（该功能已移除）。
- 文件导航标题行要与文件行对齐：`.gr-files-head-row` 的 padding 固定为 `0 max(0px, calc(var(--gr-files-scrollbar, 0px) - 2px)) 0 14px`（leading 14px = 列表 padding 6 + 行 padding 8；trailing 用 gutter 减去批量按钮内 14px 图标的视觉内缩，使最右侧图标的可见右边缘落在文件行背景的右边缘上）；`--gr-files-scrollbar` 由 `FileNav` 在 `useLayoutEffect` 里用 `list.offsetWidth - list.clientWidth` 测量后写到 `.gr-files` 根节点；`.gr-files-list` 必须保留 `scrollbar-gutter: stable`，不要写死滚动条宽度（各平台 / 浏览器不同）。
- AI 归类的分组签名必须 **path-based**：`aiEntriesSignature` 只用 `path` / `change` / `oldPath`，**不要**把 entry key、status、fingerprint 算进去——勾选（暂存 / 取消暂存）会改写 key 和指纹，若参与签名就会触发整组重新归类、列表先塌缩成「其他变更」再跳回。归类回复里的 key 必须经发送时的 key→path 表转成路径分组（`aiPathGroups`），导航再按 path 映射当前条目（`aiGroups`），否则同一文件在 staged ↔ unstaged 切换后会掉进「其他变更」。只有路径集合 / 类型变化、切换仓库、切换 AI 分组模式或手动「重新归类」才允许发起 `classify`；客户端必须把 `grouping` 随请求发送，并丢弃 `grouping` 与当前模式不一致的迟到回复；Host 缓存签名包含分组模式与该模式的附加要求。逻辑模式下分类可以带 `kind: 'non-functional'`，导航负责把该 kind 本地化为「非功能变更」并用 `description` 作为 tooltip，不要把机器名 `NON_FUNCTIONAL` 直接展示。
- diff 刷新必须保留旧值：写操作会合法地重新拉取当前条目的 diff；`app.js` 的 diff effect 用 `EntryDiff.entry.path` 判断是否同一文件，同一文件时保留上一份 `value` 并把 `loading` 置真，`diff-view.js` 只在 `loading && !entryDiff` 时渲染骨架、在 `busy || loading` 时标题行显示小 spinner；不要退回「每次 loading 都清空面板」的写法，也不要让写操作触发整页 diff 重载。
- 键盘监听挂在窗口根 DOM 节点上，而不是 `document`：快捷键只作用于当前聚焦的窗口，`Esc` 只关闭该窗口内最上层的对话框 / 菜单，不关闭窗口本身；DSH 页面其它区域的键盘操作不受影响。多个窗口同时存在时，焦点决定哪个窗口接收快捷键。
- 可聚焦控件的焦点环必须和宿主一致：统一用 `--dsw-focus-ring-color`（回退 `--dsw-alias-state-business-primary`）和 `--dsw-focus-ring-width`，不要再用 `--dsw-alias-brand-primary` 实色；也不要给焦点规则加 `!important`——DSH 在 `html[data-input-modality=pointer]` 下会把焦点环变透明，`!important` 会让插件在鼠标操作后仍留着外环（`gr-focus-silent` 是唯一例外，只用于 Esc 归还焦点）。入口按钮不要内联 `outline: none`，否则插件自己的 `:focus-visible` 规则无法生效。
- 分栏拖拽由 `app.js` 按工作区实测宽度钳制（`MIN_NAV_WIDTH` / `MIN_DIFF_WIDTH`），CSS 再用 `.gr-nav-column { max-width: calc(100% - 246px) }` 兜底；拖动线的颜色用 `--dsw-alias-label-primary` 混色，不要直接用 `--dsw-alias-brand-primary` 实色（浅色主题下接近纯黑，会显得突兀）。
- 提交区是可折叠抽屉（默认收起）：标题行显示将提交文件数与展开开关，展开后是多行提交信息文本框 + 「AI 生成提交信息」图标按钮 + **split 提交控件**（`.gr-commit-target`，与 DSH「文件资源管理器」按钮同类的交互）。split 控件的主按钮（`.gr-commit-main`，显示当前方式名称与图标）执行当前提交方式，chevron（`.gr-commit-mode-chevron`）打开二选一菜单（**提交** / **提交并推送**，当前项带勾选）；菜单用 `ContextMenu` 的 `anchorRef` + `placement: 'above'` + `align: 'end'` 紧贴 split 控件向上展开（4px 间距、右对齐；视口空间不足时由 `anchorMenuPosition` 翻转并钳制，不做高度估算），复用 `ignoreRef`；选择方式经 `settingsSet` 持久化为 `commitMode`（`'commit' | 'commitPush'`，默认 `'commit'`；早期版本持久化的 `'aiCommitPush'` 按未知值回退到 `'commit'`），重开窗口 / 刷新页面后保留（与工具栏分组选择一样的记忆方式）。没有旧的「本次将提交的内容」暂存预览列表，文件导航的文件行与分组标题勾选框（分组为半选态）承担该职责，勾选即暂存并复用 `stage` / `unstage` 协议的指纹校验。两种抽屉方式：`commit`（提交勾选内容）、`commitPush`（提交勾选内容后直接推送，不打开推送对话框），都要求提交信息非空，由 Host 解析当前分支与其上游（无上游时为默认远程 + 同名分支，`setUpstream: true`），**不调用 `pushPreview`、不开推送对话框**。顶部工具栏「推送」按钮左侧另有独立的 **「AI·提交并推送」按钮**：无需展开抽屉，一次点击依次执行 AI 草稿 → commit → push，同样不弹窗；它是独立动作而不是 `commitMode` 的取值，所以不会改变抽屉记住的 提交 / 提交并推送 方式；可用条件为「有已暂存条目、无未解决冲突、列表未截断、有可用远程且非分离 HEAD」，不满足时 tooltip 给出原因。提交成功但推送失败时用状态栏错误说明「提交成功、推送失败」，不会把已提交内容说成失败。抽屉里的 AI 草稿按钮仍只把草稿写进可编辑的提交信息框，不提交；提交信息框**不绑定任何提交快捷键**（旧的 `Ctrl` / `Cmd` + `Enter` 已移除），提交只通过 split 控件的主按钮或工具栏的 AI 按钮。设置页继续组合 `SettingSection` / `SettingRow` / `Hint`，长说明使用原生 `details` / `summary`；共享对话框焦点循环包含 `summary`，收起的内容由可见性过滤排除。
- 静态样式全部写在 `src/client/styles.js` 的字符串常量里，类名统一使用 `gr-` 前缀，避免与页面样式冲突。
- 颜色只引用主题变量（例如 `--dsw-alias-label-primary`、`--dsw-alias-bg-base`、`--dsw-alias-brand-primary`）；需要透明度或混色时用 `color-mix()` 从 token 派生，不要写字面色值。
- 样式表通过 `components.js` 的 `Styles` 组件挂到 `shell.overlay` 的常驻条目上，因此没有任何窗口、只剩输入框按钮时它仍然生效。
- 改完先跑 `npm run build`，再刷新 DSH 页面查看；`npm run validate` 会检查 `client-source` 与 `client-build` 两个门禁。**只改客户端时刷新页面即可；改了 Host 半（`src/host/`）必须重启 DSH 进程**（或重新加载插件）才会生效——否则新客户端调用新 Host 方法会得到 `protocol/unknown-method`。

## 7. 新增一个 Host 协议方法

1. 在 `src/host/index.js` 的 `methods` 表中实现方法。读参数优先复用 `src/host/protocol.js` 的读取器；新的参数形状在那里补一个读取函数并做范围校验。
2. 写操作必须包在 `serialise(...)` 写链中，且写前重新读取状态、校验指纹；返回值里回带 `repo` 与最新 `StatusPayload`。像 `remoteSet` 这类**本地配置写入**同样必须进写链：参数经 `protocol.js` 的读取器校验（名称 / 地址只做浅校验，不联网、不校验可达性），用 `git remote set-url` / `git remote add` 写本地配置后重新读取状态返回。
3. 在 `src/client/app.js` 或对应模块的调用点通过 `rpc.call('方法名', params)` 使用；`src/client/rpc.js` 是通用客户端，通常不需要改。
4. 更新 [protocol.md](./protocol.md)：方法表、参数、返回值形状、错误码。协议与代码在同一次改动内更新。
5. 补测试：`test/host-plugin.test.mjs` 覆盖分发与参数校验，`test/git-core.test.mjs` 覆盖 Git 行为；改了插槽注册或产物结构时同步更新 `test/client-bundle.test.mjs`。
6. 改了客户端源码就 `npm run build`，最后跑 `npm run validate -- --with-tests`。

## 8. 测试

测试使用 Node 内置测试运行器，不依赖任何框架；所有 Git 测试都操作真实的临时仓库。

| 文件 | 覆盖范围 |
| --- | --- |
| `test/git-core.test.mjs` | Git 引擎：状态、diff、部分暂存 / 还原、提交、推送（含本地 bare 远端）、远程配置（add / set-url）、无首次提交、重命名、冲突、特殊路径、二进制 / 符号链接 / 子模块 / 仅模式变化、stale 指纹、CRLF、截断、worktree、提交信息输入（历史格式 / 暂存 patch） |
| `test/host-plugin.test.mjs` | Host 协议：`dispatch` / 路由、设置读写、会话与仓库解析、提交预期、`remoteSet` 参数校验、AI 归类参数与回复校验、提交信息草稿（输入边界、`message/*` 失败码、取消） |
| `test/diff.test.mjs` | 纯 diff 模型：插入 / 删除 / 行数不等的替换、相邻 hunk、空文件、单行文件、CRLF、CJK、对齐不变量 |
| `test/client-bundle.test.mjs` | 产物加载：`client.js` 注册模块、工厂返回 `apply` / `inject`，并注册三个插槽条目（其中 `shell.overlay` 的窗口层条目渲染多窗口层） |
| `test/client-source.test.mjs` | 客户端源码契约回归：窗口管理 / 几何、常驻状态栏、分支菜单与远程对话框、标题行全选、AI 路径签名、diff 保留、已移除功能守卫等 |

`test/helpers/repo.mjs` 提供创建临时仓库、配置身份、提交等夹具。运行子集：

```bash
node --test test/git-core.test.mjs
node --test --test-name-pattern="stale" test/host-plugin.test.mjs
node --test --test-name-pattern="hunk" test/git-core.test.mjs
```

测试需要本机有可用的 `git`；如果 `git` 不在 `PATH` 中，Git 测试会失败并给出明确错误。Git 夹具仓库在 `.tmp-test/` 下创建（已加入 `.gitignore`），部分 Host 测试使用系统临时目录；两类仓库结束后都会清理。

## 9. 校验门禁

`npm run validate` 按固定顺序运行 8 个门禁，输出 `OK <gate>` / `FAIL <gate>: <原因>`，失败即停止：

| 门禁 | 检查内容 |
| --- | --- |
| `manifest` | `package.json` 名称 / 版本 / `type` / `license` / `main` / `private` / `exports` / `dsh` 块 / 零依赖，以及 `files` 中每个路径都存在 |
| `package-files` | 发布白名单不包含测试、脚本、临时目录、`.tgz` 等；必需运行时文件都在 |
| `client-source` | 客户端源码是合法普通脚本，无 ESM / JSX / `document.body` 写入 / 字面颜色 |
| `client-build` | `client.js` 与源码构建结果逐字节一致 |
| `host-syntax` | 每个 Host 模块能在独立 Node 进程中成功导入（捕获语法错误、坏的相对导入、顶层副作用） |
| `locales` | `locale/en.json` 与 `locale/zh.json` 都有非空的 `meta.title` / `meta.description`，且标题带包名后缀 `(@acanzaima/dsh-code-review)`（与 dsh-context 等插件在插件列表中的显示方式一致） |
| `icon` | `icon.svg` 是自包含 SVG，无外部引用 / 脚本 / 图片，大小受限 |
| `secrets` | 扫描所有将发布的文件：私钥标记、API key / token 形状、密码赋值、绝对 Windows 路径 |

`--with-tests` 会在最后追加第 9 个 `tests` 门禁（等价于 `npm run check`）。`npm run release` 把测试作为独立步骤执行，便于把失败归因到 "test" 而不是 "validate"。

## 10. 本地安装、升级与调试

1. 改动客户端源码后先 `npm run build`；只改 Host 时无需构建。
2. 在 DSH 插件管理器用 `install_bundle`，目标指向本插件目录（含 `package.json` 的那一层），或先 `npm pack` 再把 `.tgz` 作为目标。
3. **升级时先移除再安装**：插件管理器会以 `already-installed` 拒绝安装已存在的包，所以先用 `remove_bundle` 移除 `@acanzaima/dsh-code-review`，再用新目录 / 新 tarball / npm 包名安装。
4. 安装后 **刷新 DSH 页面**：`client.js` 在页面加载时注册，不刷新会继续运行旧产物。Host 半在安装操作完成 recomposition 后即生效；如果 Host 变化没有生效，重启 DSH。
5. 插件行写入当前 profile 的 `cordis.patch.yml`，`id` 为 `dsh-code-review`；同一 profile 下所有会话共享配置。
6. Host 加载成功时日志中有 `[code-review] host half loaded; route /api/code-review`。

常见问题：

| 现象 | 原因与处理 |
| --- | --- |
| `FAIL client-build` | `client.js` 过期：跑 `npm run build` 并提交产物 |
| 插件行存在但未激活 | 插件行被禁用或 profile 未应用：在插件管理器中重新启用，必要时重启 DSH |
| 输入框没有 Code Review 按钮 | `client.js` 未重新加载，或 `dsh.client` 的 `platform` / `inject` 不完整；刷新页面后确认产物最新 |
| 新功能报「Host 端不认识这个操作 / `protocol/unknown-method`」 | 客户端已更新但 Host 半还是旧进程：重启 DSH 后重试（Host 代码不会随页面刷新重载） |
| `FAIL client-source` | 客户端源码出现 ESM / JSX / 字面颜色 / `document.body` 写入；按报错的文件:行号修正 |
| `FAIL host-syntax` | Host 模块有语法错误或坏的相对导入；用报错中的 Node 输出定位 |

## 11. 发布流水线

`npm run release` 依次执行 8 个步骤，任一失败立即中止并指出步骤名：

1. `validate`——8 个门禁。
2. `test`——`node scripts/test.mjs`。
3. `build`——重新生成 `client.js`，保证发布的是最新产物。
4. `pack`——`npm pack --dry-run --json`，并断言 tarball 内容与 `files` 白名单完全一致。
5. `dry run`——带 `--dry-run` 时在此停止（不触碰认证与 registry）。
6. `auth`——`npm whoami`。
7. `version`——`npm view <name> version`；首次发布允许 404，已存在同版本则中止。
8. `publish`——`npm publish --access public`。

前置条件：已 `npm login`；npm 账号拥有包名 `@acanzaima/dsh-code-review`（scoped 包需要对该 scope 有发布权限）；`package.json` 的 `version` 已按需更新；registry 可访问。发布前先跑 dry run：

```bash
npm run release -- --dry-run
```

确认无误后执行 `npm run release`。可用 `--tag next` 指定 dist-tag，`--` 之后的参数会原样转给 `npm publish`；脚本会打印最终使用的完整命令。

发布面由 `package.json` 的 `files` 固定：Host 源码（`src/host/`）、`client.js`、`cordis.patch.yml`、locales、`icon.svg`、README 与 LICENSE。`docs/`、`test/`、`scripts/`、`.github/` 与构建配置文件都不随包发布。

README / README.en 顶部的简介图位于仓库根目录 `assets/`（`cover.zh.png` / `cover.en.png`），与 `docs/` 分开：`docs/` 只放维护者 / 集成者文档，README 素材放 `assets/`；两者都不随包发布。npm 页面渲染 README 时不会解析相对图片路径，这些图片在 npm 页面上不可见；需要显示时应改用绝对 URL。

封面是导览合成示意图：上方用简化的 DSH 输入框交代入口位置，局部放大 Code Review 按钮，再用箭头指向下方的主审阅窗口。它不是逐像素的真实截图；更新时应核对 `src/client/components.js` 中 `ReviewButton` / `ICON_PARTS.review` 的实际按钮与图标，并同步中英文版本。

### 11.1 由 tag 触发的自动发布（GitHub Actions + Trusted Publishing）

`.github/workflows/publish.yml` 在推送 `v*` tag 时自动发布，本地 `git push origin v0.2.1` 与 GitHub 页面创建 tag（Tags → New tag，或用 Release 页面新建同名 tag）都会产生 tag push 事件，触发同一个 workflow。发布通过 npm Trusted Publishing（OIDC）完成：workflow 申请 GitHub OIDC token，npm 校验「仓库 + workflow 文件名 + environment」后签发短期发布凭据，因此仓库里不需要 `NPM_TOKEN` 等长期 token（2027-01 起 bypass-2FA token 也不能再直接发布）。流程：

1. 预热 npm：Trusted Publishing 需要 npm CLI ≥ 11.5，而 Node 22 自带 npm 10，所以 workflow 先执行 `npm install -g npm@latest`。
2. 校验 tag 名与 `package.json` 的 `version` 一致（`v0.2.1` ↔ `0.2.1`），不一致直接失败。
3. 调用 `npm run release`：`release.mjs` 检测到 GitHub OIDC（`ACTIONS_ID_TOKEN_REQUEST_URL`）时跳过 `npm whoami`（没有 token 时该步骤只会 E401），其余校验 / 测试 / 构建 / 打包步骤不变，最后由 npm 交换 OIDC token 完成发布并自动附带 provenance；`0.3.0-rc.1` 这类预发布版本自动发到 `next` dist-tag 而不是 `latest`。

前置条件与注意事项：

- 在 npm 包页面 Settings → Trusted Publisher 配置 GitHub Actions：用户 `acanzaima`、仓库 `dsh-code-review`、workflow `publish.yml`、environment `npm-publish`，Allowed actions 勾选 **Allow npm publish**。该配置创建后不能修改（只能删除重建）；新建连接后需要在 npm 给出的期限内发布一次完成验证（页面显示 `Pending validation`）。
- workflow 的 `environment: npm-publish` 必须与 Trusted Publisher 的 environment 名称完全一致；如需人工审批，在仓库 Settings → Environments 给该环境加 required reviewers 即可，workflow 不需要改。
- OIDC 信任的是 workflow 身份，因此仓库侧要保护发布链路：保护 `main`、限制谁能推送 `v*` tag、对 `.github/workflows/` 使用 CODEOWNERS 审查。
- **version 变更必须先提交**，且 workflow 文件已在被 tag 的 commit 上：先推 `package.json` 版本号提交，再创建并推送 tag。
- 从 token 发布迁移过来时：Trusted Publishing 验证成功后，删除仓库的 `NPM_TOKEN` secret 并撤销旧的 bypass-2FA token；发布链条上不应再保留任何长期凭据。
- 同一个版本重复发布会失败（release 的 `version` 步骤拒绝覆盖），重跑 workflow 同理；发错版本应发新的 patch 版本。
- 该 job 只跑 `ubuntu-latest`；测试矩阵仍由 `ci.yml` 覆盖。

## 12. CI 与编码约定

`.github/workflows/ci.yml` 在推送到 `main` / `master` 和所有 Pull Request 上运行：矩阵为 `ubuntu-latest` / `windows-latest` × Node `20` / `22`（`fail-fast: false`）；因为没有依赖，工作流不执行安装步骤，依次运行 `npm test`、`npm run validate`，并在 Ubuntu + Node 20 上额外运行 `npm run pack:check`；权限只读（`contents: read`），同一分支的旧运行会被取消。新增门禁时确保 CI 调用覆盖本地发布前的同一组检查。`.github/workflows/publish.yml` 只在 `v*` tag 上运行，直接复用 `npm run release`，通过 Trusted Publishing（OIDC）发布、不使用仓库 secret，也不在 workflow 里重复实现发布门禁。

编码约定：

- Host 半是 ESM，导入 Node 内置模块时使用 `node:` 前缀；不引入任何运行时依赖。
- 调用外部命令只用 argv 数组，不经过 shell；路径作为参数值传递，不拼接命令字符串。
- 协议方法名用小驼峰，错误码用 `<区域>/<原因>` 形式，并在 [protocol.md](./protocol.md) 中登记。
- 客户端模块之间只通过 `require('名字')` 引用；跨模块共享的状态放进 `state.js` 的 store，而不是模块级可变全局。
- 依赖 DSH 的可选能力时不要改 exports.inject：用 ctx.get(''remote.session'') 并在服务缺失时降级（见 src/client/open-in-app.js）；目录应用目录与启动复用 DSH 的 open-in-app/* 路由，不要自己 spawn 桌面进程。
- 测试断言对外行为（协议返回、Git 结果、DOM 结构与交互模型），不断言内部实现细节；改行为就同步改文档与 `CHANGELOG.md`。
