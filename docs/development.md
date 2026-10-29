# FontFox 开发文档

面向开发者与 AI 助手：构建方式、数据落点、保护判定、边界与目录结构。界面规范见
[ui-spec.md](ui-spec.md)，模块与 IPC 契约见 [architecture.md](architecture.md)。

## 定位

Windows 字体管理器：枚举本机全部字体，可就地隐藏 / 显示、整理成字体单，并在保护系统关键字体的
前提下干净删除非保护字体。

- 界面由系统 Edge WebView2 渲染（Tauri v2 + Rust），不内置浏览器内核、不内置任何字体文件
- 不装字体驱动、不常驻服务、不建立独立字体数据库
- **默认以普通用户运行（不弹 UAC）**：只有删除系统作用域字体时才临时申请一次管理员权限
- 删除同时清理字体文件与注册表值；文件被 GDI 锁定时进入待清理清单，下次启动重试

## 功能

| 能力 | 说明 |
| --- | --- |
| 双源字体枚举 | 同时读 `HKLM` / `HKCU` 的 `...\CurrentVersion\Fonts`，解析文件 `name` 表拿家族名、样式、语言、版本、版权；`.ttc` 按 face 展开 |
| 紧凑 / 预览视图 | 38px 紧凑行或 76px 预览行（24px 样字），虚拟滚动，500+ 字体不卡顿 |
| 排序 | 字体名称 / 语言 / 大小 / 状态，点击表头切换升降序 |
| 分组 | 六种依据：不分组（默认）/ 启用状态 / 样式类型 / 可修改性 / 安装位置 / 安装时间；分组带可折叠、吸顶 |
| 筛选 | 语言、样式（单样式 / 多样式 / 可变字体）、大小区间、特性（等宽 / 连字 / 可变）；可一键清除 |
| 搜索 | 名称 / 文件名实时过滤，Esc 清空 |
| 隐藏 / 显示 | 两种模式：**Windows 基础模式**读写 `HKCU\...\Font Management\Inactive Fonts`（`REG_MULTI_SZ`，即时生效，Adobe 等直接读注册表的软件仍可见）；**动态安装卸载模式**删除 `HKCU\...\Fonts` 值并把文件移入隔离目录，重启应用后彻底不可见（仅用户作用域） |
| 删除字体 | 用户字体直接删除；系统作用域字体运行时提权（一次 UAC）；文件锁定则登记待清理 |
| 注册表残留清理 | 文件已缺失的条目可只清注册表 |
| 保护判定 | 文件所有权（TrustedInstaller / SYSTEM）为主判据，微软官方清单与内置补充清单兜底，另有光栅字体、共享系统文件判定 |
| 收藏 / 字体单 | 收藏字体、自建字体单（最多 20 个，各有标记色），右键「添加到字体单」 |
| 详情面板 | 可折叠；完整名称、语言、版本、版权、路径、文件大小，支持复制与「打开文件位置」 |
| 外观 | 浅色 / 深色 / 跟随系统；自绘标题栏与窗口按钮，原生边框主题同步 |
| 键盘 | ↑ / ↓ 移动选择，Esc 取消选择、清空搜索 |
| 语言 | 外挂 `lang/<id>.ini`，当前提供简体中文；缺失键直接显示键名，便于发现漏翻 |

## 技术栈

- **应用外壳**：Tauri v2（Rust 1.77+，`windows-sys` / `winreg`）
- **字体解析**：`ttf-parser`（只读 `name` 表，支持 `.ttc` 多 face 匹配）
- **前端**：Vite 7 + TypeScript（无框架，手写虚拟滚动与悬浮滚动条）
- **图标**：`@siemens/ix-icons`（MIT）+ 少量自绘 SVG，构建时内联，不发起网络请求
- **打包**：NSIS（每机器安装；清单为 `asInvoker`，安装过程不要求管理员）
- **窗口**：透明无边框窗口（`shadow: false`），DWM 的圆角与描边关闭、只保留动画；四周留 24px 给 `.app` 自绘的 4px 圆角、1 物理像素描边与阴影（失焦收小、最大化归零）。`frame.rs` 接管 `WM_NCHITTEST`：阴影区穿透，内容边缘 5px 为缩放热区；命中区设备像素由前端 `set_frame_metrics` 同步，避免 DPI 与页面缩放不一致时错位

## 开发环境

前置：Rust（MSVC 工具链 + Windows SDK）、Node.js 20+、WebView2 运行时（Windows 10/11 自带）。

双击根目录的 `dev.cmd` 会检查 Node / Rust / 依赖 / 端口占用并启动 `tauri dev`，
前端与 Rust 代码都会热重载。首次编译 Rust 约 1 分钟，之后数秒。关闭控制台窗口即停止全部进程。

命令行方式：

```powershell
npm install
npm run tauri dev        # 开发（Vite + 热更新）
npm run tauri:build:exe  # 只出可执行文件，不打包安装器
npm run tauri build      # 出安装包（src-tauri/target/release/bundle/nsis）
```

检查与测试：

```powershell
npx tsc --noEmit                                        # 前端类型检查
npm run build                                           # 前端构建
cargo test --manifest-path src-tauri/Cargo.toml --lib    # Rust 单元测试
```

更新内置数据 / 图标：

```powershell
python tools/parse_official.py --refresh   # 拉取 Microsoft Learn 的 Win10/11 字体列表
python tools/make_icons.py                 # 重新生成应用图标
```

`tools/parse_official.py` 只处理微软官方列表。Learn 的列表**不覆盖**全部随系统分发的字体
（`.fon` 光栅字体、语言包字体、24H2 起的 Noto CJK 等），这部分由手工维护的
`src-tauri/src/data/core_fonts.json` 补充，避免把真实系统字体误判为「可删除的第三方字体」。

## 目录结构

```
src/                前端：入口 main.ts、虚拟列表、行渲染、详情、菜单、i18n、悬浮滚动条
src/assets/icons/   自绘 SVG 图标
src-tauri/src/      Rust：枚举、解析、保护判定、隐藏/删除、提权、设置与字体单存储
src-tauri/src/data/ 内置字体清单（official_fonts.json / core_fonts.json）
langBuild/          语言包唯一源文件（构建时复制到 exe 同级 lang/）
docs/               UI 规范、架构说明、开发文档、截图
tools/              图标生成、官方清单抓取、语言包复制脚本
```

## 内存

预览样字由 **Rust 栅格化**（`src-tauri/src/preview.rs`），前端只贴 PNG：

- 字体文件只在 Rust 里读一次，渲染成小位图后立即释放；
- 行的样字按「路径 + 文本 + 字号 + 颜色 + DPR」缓存为 data URL（前端 400 条上限，
  Rust 侧 PNG 缓存 400 条 / 48MB）；
- 缺字时用系统字体（`msyh.ttc`）回退，和浏览器的字形回退一致；
- WebView 不再通过 `@font-face` 加载任何字体文件。

> 关键背景：Chromium 会把加载过的字体缓存在**渲染进程级**，删除 `FontFace`、
> 整页重载、销毁 Worker 都不会释放。曾用 `@font-face` 方案滚完 488 个字体后
> renderer 涨到约 1.1GB，这是改为 Rust 栅格化的原因。

2026-10 实测（dev 构建，150% 缩放，预览模式滚完整列表）：renderer 104MB → 128MB
（稳定后约 117MB），主进程约 79MB；改动前同样操作 renderer 会到 1.1GB。

## 保护策略

只有 `HKLM` 作用域的字体可能被标记为受保护，判定顺序：

1. 文件所有权为 TrustedInstaller / SYSTEM → 受保护
2. 命中微软 Windows 10 / 11 官方字体列表（文件名或家族名）→ `official`
3. `.fon` / `.fnt` 光栅字体 → `raster`
4. 命中内置补充清单（`core_fonts.json`）→ `core`
5. 注册在 `HKCU` 但文件位于 `%WINDIR%\Fonts` → `shared-system-file`

其余 `HKLM` 字体（用户自行安装到系统目录的第三方字体）可删除，删除时请求管理员权限。
受保护字体不提供任何强制删除入口。

## 数据位置

| 数据 | 位置 | 卸载时 |
| --- | --- | --- |
| 用户偏好 | `%USERPROFILE%\.FontFox\config.ini` | **删除整个目录** |
| 收藏 / 字体单 | `%USERPROFILE%\.FontFox\library.json` | 删除（随目录一起） |
| 待清理文件清单 | `%USERPROFILE%\.FontFox\pending-delete.json` | 删除（随目录一起） |
| 动态模式隔离字体 | `%USERPROFILE%\.FontFox\disabled\`（字体文件 + 同目录下的 `disabled.json` 清单） | 删除（随目录一起；先「全部启用」更稳妥） |
| 字体隐藏状态 | `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Font Management\Inactive Fonts` | **保留**（属于用户对字体的功能状态，不是应用设置） |

FontFox 不会在卸载时清理任何字体注册项。

## 已知边界

- **默认以普通用户运行**：只有删除系统作用域字体时才用 `runas` 拉起删除子进程，仅那一步弹一次 UAC；
  取消即放弃删除，主程序不受影响。
- `Inactive Fonts` 的官方语义是「隐藏」，不是内核级禁用。部分缓存了字体表的旧应用可能仍能枚举到，
  通常需要重启或重新登录才完全生效。
- 删除时若字体文件被当前会话的 GDI 锁定，注册表会先清理（重启后不再加载），文件登记到待清理清单，
  下次启动重试；提权子进程会直接完成删除，不经过清单。
- **预览通过 asset 协议读取字体文件**：系统字体目录在运行时按 `%SystemRoot%\Fonts` 动态加入作用域。
  若文件被权限或安全软件拦截，预览回退到界面字体，行 tooltip 与详情面板会显示失败原因。
- 不修改字体文件内容，不重命名、不编辑字体。
- 自绘标题栏意味着 Win11「悬停最大化按钮弹出贴靠布局」不可用（该能力只随系统标题栏提供）。
- 分组依据、筛选条件为会话内状态，重启后回到默认（不分组、无筛选）；视图模式、主题、预览文字、
  详情面板开合、语言、禁用方式会写入配置。
- **禁用状态持久化**：退出应用不会自动恢复字体，`disabled.json` 里的记录下次启动继续有效；
  动态模式下改动隔离目录会触发启动对账弹窗（补充未登记文件 / 清理失效记录）。
- 动态安装卸载模式只处理用户作用域字体：系统作用域字体需要提权改动 `C:\Windows\Fonts` 与 `HKLM`，
  切换模式时会自动沿用 Windows 隐藏；在日常开关里也会拒绝并提示。
- 动态模式禁用正在被应用加载的字体时，移动文件会失败并提示；关闭占用字体的程序后重试即可。
- 语言包是 exe 同级的 `lang/<id>.ini`：`npm run dev` / `npm run build` 由 `tools/copy-lang.mjs`
  复制，`build.rs` 在编译期再兜底一次，打包时按 `bundle.resources` 映射进安装目录。改文案可
  直接编辑 exe 旁那份 `lang/schinese.ini`。

## 许可证

Copyright © 2026 Raku Inkyetta 羽梦千景。以 Apache License 2.0 授权，见 [LICENSE](../LICENSE)；
第三方组件与数据来源见 [NOTICE](../NOTICE)。应用内「关于 / 许可」可查看完整文本。

## 相关链接

- 仓库：<https://github.com/AomiRaku/font-fox>
- 问题反馈：<https://github.com/AomiRaku/font-fox/issues>

## 相关文档

- [ui-spec.md](ui-spec.md)：设计语言、令牌、组件、状态、自检清单
- [architecture.md](architecture.md)：运行形态、模块职责、IPC 契约、数据流
- [AGENTS.md](../AGENTS.md)：协作与提交约定