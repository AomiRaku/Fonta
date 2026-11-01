# FontFox 开发文档

面向开发者与 AI 助手：构建方式、数据落点、保护判定、边界与目录结构。界面规范见
[ui-spec.md](ui-spec.md)，模块与 IPC 契约见 [architecture.md](architecture.md)。

## 定位

Windows 字体管理器：枚举本机全部字体，可就地停用 / 启用、整理成字体单，并在保护系统关键字体
的前提下干净删除非保护字体。

- 界面由系统 Edge WebView2 渲染（Tauri v2 + Rust），不内置浏览器内核、不打包任何字体文件
- 不装字体驱动、不常驻服务、不建立独立字体数据库
- **应用以普通用户运行（不弹 UAC）**：只有删除系统作用域字体时才临时申请一次管理员权限
- 删除同时清理字体文件与注册表值；文件被 GDI 锁定时进入待清理清单，下次启动重试

## 系统要求

- **Windows 10 1809（build 17763）及以上，仅 64 位**；推荐 Windows 11。更低版本未验证（WebView2 与用户级字体机制都要求 1809 以上）
- 需要 WebView2 运行时 110.0.1587.0 或更高：Windows 11 与已更新的 Windows 10 自带；缺失或过旧时由安装器联网安装
- 窗口圆角由 DWM 提供：Windows 11 使用系统默认圆角，Windows 10 上是直角

## 功能

| 能力 | 说明 |
| --- | --- |
| 双源字体枚举 | 同时读 `HKLM` / `HKCU` 的 `...\CurrentVersion\Fonts`，解析文件 `name` / `fvar` / `GSUB` 拿家族名、样式、语言、版本、版权、可变字体轴范围；`.ttc` 按 face 展开 |
| 紧凑 / 预览视图 | 38px 紧凑行或 76px 预览行（行内样字 24px，由 Rust 栅格化），虚拟滚动只渲染可视区 |
| 排序 | 字体名称 / 语言 / 大小 / 状态，点击表头切换升降序 |
| 分组 | 六种依据：不分组（默认）/ 启用状态 / 样式类型 / 可修改性 / 安装位置 / 安装时间；分组带可折叠、吸顶 |
| 筛选 | 语言、样式（单样式 / 多样式 / 可变字体）、大小区间、特性（等宽 / 连字 / 可变）；可一键清除 |
| 搜索 | 名称 / 文件名实时过滤，Esc 清空 |
| 停用 / 启用 | 两种模式：**Windows 基础模式**读写 `HKCU\...\Font Management\Inactive Fonts`（`REG_MULTI_SZ`，即时生效；按单个样式写入展示名 / 文件名，同族样式可分别停用）；**动态安装卸载模式**删除 `HKCU\...\Fonts` 值并把文件移入隔离目录，仅用户作用域。任一字体失败时整批回滚并返回错误 |
| 删除字体 | 用户字体直接删除；系统作用域字体运行时提权（一次 UAC）；文件锁定则登记待清理 |
| 注册表残留清理 | 文件已缺失的条目可只清注册表 |
| 保护判定 | 文件所有权（TrustedInstaller / SYSTEM）为主判据，内置系统字体保护清单与补充清单兜底，另有光栅字体、共享系统文件判定 |
| 收藏 / 字体单 | 收藏字体、自建字体单（最多 20 个，各有标记色），右键「添加到字体单」 |
| 详情面板 | 可折叠；完整名称、语言、版本、版权、路径、文件大小，支持复制与「打开文件位置」；可变字体带字重滑块 |
| 外观 | 浅色 / 深色 / 跟随系统；自绘标题栏与窗口按钮，窗口圆角 / 描边 / 阴影由 DWM 提供 |
| 键盘 | ↑ / ↓ 移动选择，Ctrl+A 全选列表且任何位置都不选中界面文字（输入框内除外），Delete 等同删除按钮，Esc 取消选择、清空搜索；模态弹窗打开或输入框聚焦时不接管这些快捷键 |
| 语言 | 外挂 `lang/<id>.ini`，默认跟随系统语言；当前提供 zh-CN、zh-HK、zh-TW、zh-MO、zh-WY、en-US、fr-FR、ru-RU、ja-JP、ko-KR；`[meta] LanguageCode` 提供 BCP 47 代码；缺失键直接显示键名，便于发现漏翻；文案里的字面 `\n` 会转成换行 |

## 技术栈

- **应用外壳**：Tauri v2（Rust 1.77+，`windows-sys` / `winreg` / `memmap2` / `ab_glyph` / `png`）
- **字体解析**：`ttf-parser` 只读 `name` / `fvar` / `GSUB`，支持 `.ttc` 多 face 匹配
- **前端**：Vite 7 + TypeScript（无框架，手写虚拟滚动与悬浮滚动条）
- **图标**：`@siemens/ix-icons`（MIT），自绘图标可放入 `src/assets/icons/`；构建时内联，不发起网络请求
- **窗口**：不透明、无边框（`decorations: false`、`shadow: true`、`backgroundColor: #F7F7F8`）；
  DWM 负责系统圆角、描边、阴影与窗口动画，页面不画窗口外壳。保持系统默认圆角，
  不要覆盖 `DWMWA_WINDOW_CORNER_PREFERENCE`：Windows 11 上 `ROUNDSMALL` 或直角偏好会明显缩小 DWM 阴影
- **打包**：NSIS，机器级安装（安装 / 卸载需要管理员权限；应用本身清单为 `asInvoker`）

## 开发环境

前置：Rust（MSVC 工具链 + Windows SDK）、Node.js 20.19+ 或 22.12+、WebView2 运行时。

双击根目录的 `dev.cmd` 会检查 Node / Rust / 依赖 / 端口占用并启动 `tauri dev`，
前端与 Rust 代码都会热重载。首次编译 Rust 约 1 分钟，之后数秒。关闭控制台窗口即停止全部进程。

Vite 固定使用 **1420** 端口。若上一次 `tauri dev` 的进程没退干净，启动会报
`Port 1420 is already in use` 并退出：先结束残留的 `node`（`npm run dev` / `vite`）再重新运行即可。

命令行方式：

```powershell
npm install
npm run tauri dev        # 开发（Vite + 热更新）
npm run tauri:build:exe  # 只出可执行文件，不打包安装器
npm run tauri:build      # 出安装包并重命名为 FontFox_[major.minor]_x64.exe（src-tauri/target/release/bundle/nsis）
```

检查与测试：

```powershell
npx tsc --noEmit                                        # 前端类型检查
npm run build                                           # 前端构建
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust 单元测试
```

更新内置数据 / 图标：

```powershell
npx tauri icon path/to/icon.png            # 重新生成 src-tauri/icons/（应用图标）
```

`src-tauri/src/data/system_fonts.json` 是独立维护的 Windows 系统字体兼容清单，只保存字体
家族名与文件名；仓库和构建流程不包含网页抓取脚本，也不在构建时访问网络。主清单**不覆盖**
全部随系统分发的字体（`.fon` 光栅字体、语言包字体、24H2 起的 Noto CJK 等），这部分由手工维护的
`src-tauri/src/data/core_fonts.json` 补充，避免把真实系统字体误判为「可删除的第三方字体」。

## 目录结构

```
src/                前端：入口 main.ts、虚拟列表、行渲染、详情、菜单、i18n、悬浮滚动条
src/assets/icons/   自绘图标扩展目录
src-tauri/src/      Rust：枚举、解析、保护判定、停用 / 删除、提权、设置、字体单、预览栅格化
src-tauri/src/data/ 内置字体清单（system_fonts.json / core_fonts.json）
langBuild/          语言包唯一源文件（构建时复制到 exe 同级 lang/）
docs/               UI 规范、架构说明、开发文档、截图
tools/              语言包复制、第三方许可证生成、设计稿解析脚本
```

## 内存

预览样字由 **Rust 栅格化**（`src-tauri/src/preview.rs`），前端只贴 PNG：

- 字体文件用 mmap 缓存（最多 8 个），以「路径 + 文件长度 + 修改时间」为键，文件被替换后自动重读；删除字体前释放全部缓存，避免 Windows 因文件仍被映射而拒绝删除；
- 行的样字按「路径 + 文本 + 字号 + 颜色 + DPR」缓存为 data URL（前端 400 条上限，
  Rust 侧 PNG 缓存 400 条 / 48MB）；
- 字体里没有的字符直接跳过（不回退到别的字体）；`max_width` 大于 0 时按词 / 字符折行
  （详情面板用面板宽度，行内样字单行）；
- 预览文字在该字体里一个字形都没有时：**默认预览文字**从字体 cmap 的全部子表
  （含 Windows symbol 编码）取样最多 24 个字符（符号 / 图标字体靠这个显示图标）；
  **手动输入的预览文字**返回 `NO_GLYPHS`，前端显示「预览文字没有对应字符」；
- 详情面板的「字重」滑块以 `fresh` 方式渲染（不读 / 不写缓存，只保留最后一张），
  切换字体时释放；松手后的最终字重才进缓存；
- WebView 不加载任何字体文件。

> 约束来源：Chromium 的字体缓存属于**渲染进程级**，删除 `FontFace`、整页重载、销毁 Worker
> 都无法释放，用 `@font-face` 滚完整个字体库会让 renderer 涨到 GB 级，所以预览改由 Rust 出图。

2026-10 实测（dev 构建，150% 缩放，预览模式滚完整列表）：renderer 104MB → 128MB
（稳定后约 117MB），主进程约 79MB。

## 保护策略

只有 `HKLM` 作用域的字体可能被标记为受保护；`HKCU` 作用域直接视为可操作。判定顺序：

1. 文件位于 `%WINDIR%\Fonts` 但注册在 `HKCU` → `shared-system-file`
2. 文件所有权为 TrustedInstaller / SYSTEM → `system`
3. 命中内置 Windows 系统字体保护清单（文件名或家族名）→ `system`
4. `.fon` / `.fnt` 光栅字体 → `raster`
5. 命中内置补充清单（`core_fonts.json`）→ `core`

其余 `HKLM` 字体（用户自行安装到系统目录的第三方字体）可删除，删除时请求管理员权限。
受保护字体不提供任何强制删除入口。

## 数据位置

| 数据 | 位置 | 卸载时 |
| --- | --- | --- |
| 用户偏好 | `%USERPROFILE%\.FontFox\config.ini` | 删除整个目录 |
| 收藏 / 字体单 | `%USERPROFILE%\.FontFox\library.json` | 删除（随目录一起） |
| 待清理文件清单 | `%USERPROFILE%\.FontFox\pending-delete.json` | 删除（随目录一起） |
| 更新安装包 | `%USERPROFILE%\.FontFox\update\` | 删除（随目录一起） |
| 动态模式隔离字体 | `%USERPROFILE%\.FontFox\disabled\`（字体文件 + 同目录的 `disabled.json`） | 先恢复（迁回用户字体目录并重新注册），再删除目录 |
| 字体停用状态（Inactive Fonts） | `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Font Management\Inactive Fonts` | 按禁用模式处理：`dynamic` 自动恢复；`windows` 询问后清空（见下节） |

## 卸载行为

安装器的 `PREUNINSTALL` 钩子读取 `config.ini` 的 `DisableMode`：

1. **动态安装卸载模式**（`dynamic`）：静默执行 `fontfox.exe --restore-fonts`，把 `disabled\` 里的
   隔离字体迁回 `%LOCALAPPDATA%\Microsoft\Windows\Fonts` 并重新写入 `HKCU\...\Fonts`——必须恢复，不询问；
2. **Windows 基础模式**（`windows`）：弹窗询问「是否恢复所有已停用的字体？」；选「是」才执行同一个
   命令（删除 `Inactive Fonts` 值），选「否」保持现状。

恢复失败时应用会弹出原生「恢复字体失败」对话框：只有一个「重试」按钮，点窗口关闭同样按重试处理。
首次失败后最多重试 4 次；仍失败则把 `disabled\` 里剩余的字体文件复制到
`桌面\FontFox Uninstalled Fonts`（兼容 OneDrive 桌面），并提示可手动重新安装。

安装器在已有安装上直接覆盖，不显示卸载选项，安装目录固定为上次安装位置且不可编辑；卸载仍通过系统「应用」或应用自身入口执行。`POSTUNINSTALL` 默认删除 `%USERPROFILE%\.FontFox\`；带 `/UPDATE` 时跳过恢复与删除。若恢复最终失败（`--restore-fonts` 以非零退出码结束），
则保留该目录，避免隔离字体在复制不完整时被一并删除。恢复结果会写入 `%TEMP%\fontfox-restore.log`。

## 已知边界

- **默认以普通用户运行**：只有删除系统作用域字体时才用 `runas` 拉起删除子进程，仅那一步弹一次 UAC；
  取消即放弃删除，主程序不受影响。
- `Inactive Fonts` 的系统语义是「隐藏」，不是内核级禁用。部分缓存了字体表的旧应用可能仍能枚举到，
  通常需要重启或重新登录才完全生效。
- 卸载器以提升权限运行；若使用与原用户不同的管理员账户执行卸载，`$PROFILE` 指向该管理员账户，可能无法恢复或清理原用户数据。
- 更新包校验 HTTP 长度与 `MZ` 头，未验证 Authenticode 签名。
- 删除时若字体文件被当前会话的 GDI 锁定，注册表会先清理（重启后不再加载），文件登记到待清理清单，
  下次启动重试；提权子进程会直接完成删除，不经过清单。
- 预览由 Rust 直接读取字体文件（mmap）；若文件被权限或安全软件拦截，行与详情会显示加载失败。
- 不修改字体文件内容，不重命名、不编辑字体。
- 自绘标题栏意味着 Win11「悬停最大化按钮弹出贴靠布局」不可用（该能力只随系统标题栏提供）。
- 分组依据、筛选条件、预览文字为会话内状态，重启后回到默认（不分组、无筛选、预览框为空）；
  视图模式、主题、详情面板开合、语言、行悬停开关、自动检查更新开关、更新源、忽略的更新版本、禁用方式会写入配置；禁用方式变更先写入 `DisableModeNext`，重启启动时执行迁移后再清空。
- **禁用状态持久化**：退出应用不会自动恢复字体，`disabled.json` 里的记录下次启动继续有效；
  动态模式下改动隔离目录会触发启动对账弹窗（补充未登记文件 / 清理失效记录）。
- 动态安装卸载模式只处理用户作用域字体：系统作用域字体需要提权改动 `C:\Windows\Fonts` 与 `HKLM`，
  切换模式时会自动沿用 Inactive Fonts（隐藏）；在日常开关里也会拒绝并提示。
- 动态模式禁用正在被应用加载的字体时，移动文件会失败并提示；关闭占用字体的程序后重试即可。删除隔离中的字体时使用 `disabled.json` 里的真实路径，删除前会先释放预览 mmap。
- 语言包是 exe 同级的 `lang/<id>.ini`：`predev` / `prebuild` 由 `tools/copy-lang.mjs` 复制，
  `build.rs` 在编译期再兜底一次，打包时按 `bundle.resources` 映射进安装目录。复制时目标目录里
  存在、但 `langBuild` 已没有的 `.ini` 会被删除。改文案编辑 `langBuild/zh-cn.ini`，重新构建后会复制到 exe 同级 `lang/`。
- 每个语言包在 `[meta]` 中提供 `LanguageCode`（BCP 47，如 `zh-CN`）。设置默认值为「使用系统语言」：
  通过 `GetUserDefaultLocaleName` 读取系统 locale，先精确匹配代码；简体中文区域（`zh-Hans` / `zh-SG` / `zh-MY` / `zh-CN`）未命中回退 `zh-CN`，繁体区域（`zh-Hant` / `zh-TW`）回退 `zh-TW`，其余 `zh-*` 回退 `zh-HK`；其他语言未命中时优先同主语言，再回退 `en-US`，仍缺失再回退 `zh-CN`（`zh-cn.ini`）。回退时设置仍保持「使用系统语言」。

- 后端返回的错误字符串为英文，前端只翻译外层提示模板；系统调用返回的文本可能跟随 Windows 显示语言。

## 软件更新

- 更新检查通过 GitHub Releases API 读取最新 `tag_name` 与原始 `body`；GitHub 源直连 `api.github.com`；镜像源1 的 API 前缀为 `https://github.chenc.dev/https:/api.github.com`（单个斜杠），下载前缀为 `https://github.chenc.dev/`；镜像源2 加 `https://gh-proxy.org/` 前缀。网络请求跟随 Windows 系统代理，并支持 `HTTP(S)_PROXY` / `NO_PROXY` 环境变量。
- 版本比较按 `tag` 去掉 `v` 后的数字段补零后比较，只有更高版本才视为更新。
- 启动后静默检查（仅「检查更新」开关开启时）；关于窗口打开时也自动检查但不弹窗（同样受开关控制）。手动检查才显示「已是最新版本」「更新失败」等结果。
- 「不提醒此版本」写入 `config.ini` 的 `IgnoredUpdateVersion`；仅忽略相同版本，更高版本会恢复提示。
- Release 正文只取第一个 `***` 之前的内容，再按 `---` 分为中文 / 英文；当前语言代码为 `zh-*` 时取中文，否则取英文，空段回退另一段。按纯文本展示，不渲染 Markdown。
- 下载地址为 `https://github.com/AomiRaku/font-fox/releases/latest/download/FontFox_[版本号]_x64.exe`；`npm run tauri:build` 会在打包后自动重命名为该格式；安装包写入 `%USERPROFILE%\.FontFox\update\`；进度通过 `update-download` 事件推送。取消或失败会删除临时文件；完成后启动安装包并退出应用。应用启动时会清理 update 目录中遗留的安装包。
## 安装器外观

- 欢迎页 / 完成页左侧插图：`docs/img/install.bmp`（164×314 BMP），由 `bundle.windows.nsis.sidebarImage` 引用。
- 安装界面字体：自定义模板 `src-tauri/nsis/installer.nsi` 使用 `MUI_LANGUAGEEX`，指向 `src-tauri/nsis-lang/mui/` 下的 `SimpChinese.*` / `English.*`；这两个 NLF 的字体设为 `Microsoft YaHei` 9 号。
- `src-tauri/nsis-lang/*.nsh` 是 Tauri 安装器的自定义文案，在语言加载后追加，修改时保留原有 `LangString`。
- NSIS 模板有变化时，需同步 `src-tauri/nsis/installer.nsi` 并保留语言加载段。

## 第三方许可证

- `THIRD_PARTY_LICENSES.txt` 由 `npm run third-party` 生成；数据来源为 `cargo metadata`、Windows 目标的 `cargo tree` 与前端运行时依赖。
- 生成器按包名和版本列出依赖，许可证全文去重后编号；构建工具与未进入 Windows 构建的依赖不列出。
- 文件作为安装包资源分发，并在「开源许可 → 第三方组件」显示；新增或升级依赖后需重新生成。

## 版本号

- 对外版本使用 `major.minor`，不补前导零：当前 **1000.3**，后续例如 `1021.0`、`1220.0`、`2200.13`。
- 内部需要 semver 的工具（Cargo / Tauri / NSIS）使用 `major.minor.0`，例如 `1000.3.0`；`about` 与 `app_info` 对外显示 `major.minor`。
- 发版时同步：`package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（fontfox 条目）、`src-tauri/tauri.conf.json`。

## 许可证

Copyright © 2026 羽梦千景 Raku Inkyetta。以 Apache License 2.0 授权，见 [LICENSE](../LICENSE)；
第三方组件与数据来源见 [NOTICE](../NOTICE)。应用内「关于 / 许可」可查看完整文本。

## 相关链接

- 仓库：<https://github.com/AomiRaku/font-fox>
- 问题反馈：<https://github.com/AomiRaku/font-fox/issues>

## 相关文档

- [ui-spec.md](ui-spec.md)：设计语言、令牌、组件、状态、自检清单
- [architecture.md](architecture.md)：运行形态、模块职责、IPC 契约、数据流
- [AGENTS.md](../AGENTS.md)：协作与提交约定
