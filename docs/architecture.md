# FontFox 架构说明

本文描述当前的实现结构：模块职责、进程模型、IPC 契约与关键机制。界面规范见
[ui-spec.md](ui-spec.md)，构建、数据落点与边界见 [development.md](development.md)。

## 运行形态

- 单个 Tauri v2 进程 + 一个 WebView2 窗口，前端为无框架 TypeScript。
- 前端不直接触达文件系统或注册表，一切系统操作都通过 IPC 命令。
- 删除系统作用域字体时，主进程用 `ShellExecuteExW` + `runas` 拉起自身的一个**无窗口子进程**，
  由它完成删除；其余操作全部在普通权限下进行。
- 应用清单 `asInvoker`，安装器按机器级安装但不要求管理员运行。

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 应用入口：状态、渲染编排、事件绑定、启动流程 |
| `src/list.ts` | 虚拟列表（行高、偏移、可见区间、滚动锚定） |
| `src/rows.ts` | 行 DOM：字体行、字族行、分组带 |
| `src/detail.ts` | 详情面板（单字体 / 多 face / 空态） |
| `src/filtermenu.ts` | 筛选菜单（分类 tab + 选项面板 + 清除筛选） |
| `src/contextmenu.ts` | 右键菜单与二级菜单（「添加到字体单」） |
| `src/scrollbar.ts` | 悬浮滚动条（不占轨道、可拖动、常驻 / 淡出两种模式） |
| `src/preview.ts` | 预览渲染池：用 `@font-face` + asset 协议加载本机字体 |
| `src/i18n.ts` | 语言包载入、`t()` 插值、静态文案替换 |
| `src/icons.ts` | SVG 图标注册、归一化（`currentColor`、去 id、展开 style） |
| `src/api.ts` | IPC 封装与错误文本化 |
| `src/types.ts` | 前后端共享的数据结构 |
| `src-tauri/src/enumerate.rs` | 注册表枚举 → `FontEntry`，含文件元数据与安装时间 |
| `src-tauri/src/parse.rs` | `ttf-parser` 读取 `name` / `fvar` / `GSUB`，TTC face 匹配 |
| `src-tauri/src/official.rs` | 官方字体清单与 `core_fonts.json` 匹配 |
| `src-tauri/src/ownership.rs` | 文件所有者判定（TrustedInstaller / SYSTEM） |
| `src-tauri/src/inactive.rs` | `Inactive Fonts` 读写与比对（Windows 基础模式） |
| `src-tauri/src/mode.rs` | 动态安装卸载模式：注销注册表值 + 隔离文件，维护 `disabled.json` |
| `src-tauri/src/frame.rs` | 窗口外观：通过 DWM 设置 4px 圆角 |
| `src-tauri/src/delete.rs` | 删除、待清理清单、提权子进程入口 |
| `src-tauri/src/elevation.rs` | 提权拉起自身子进程 |
| `src-tauri/src/settings.rs` / `library.rs` | `config.ini` 与 `library.json` 读写 |
| `src-tauri/src/i18n.rs` | 外挂语言包解析（`section.key`） |
| `src-tauri/src/commands.rs` | 全部 IPC 命令实现 |
| `src-tauri/src/model.rs` | 数据模型与序列化 |
| `src-tauri/build.rs` | 编译期复制 `langBuild/*.ini` 到 `target/<profile>/lang/` |

## IPC 命令

| 命令 | 入参 | 返回 |
| --- | --- | --- |
| `list_fonts` | — | `{ fonts, scannedMs, lockedFiles }` |
| `set_fonts_hidden` | `ids`, `hidden` | `{ changed }` |
| `delete_fonts` | `ids` | `{ removedCount, lockedCount, errors, cancelled }` |
| `clean_missing` | `ids` | 同上 |
| `retry_pending_deletes` | — | 清理成功的数量 |
| `get_settings` / `save_settings` | `settings` | 设置结构 |
| `load_library` / `save_library` | `library` | 收藏与字体单 |
| `about` | — | 版本、许可证、配置路径、待清理路径 |
| `reveal_path` | `path` | 在资源管理器中定位（系统字体目录走 `shell:Fonts`） |
| `registry_location` | `scope` | 注册表路径（详情面板展示） |
| `system_theme` | — | `light` / `dark`（读 `AppsUseLightTheme`） |
| `load_language` | `id` | 解析后的语言包 |
| `set_disable_mode` | `mode`（`windows` / `dynamic`） | `{ mode, migrated, failed, errors }`，内部完成旧模式恢复 → 切换 → 新模式重禁用 |
| `reconcile_disabled` | — | `{ extra, missing }`：隔离目录多出的文件、清单里丢失的文件 |
| `adopt_disabled_files` | `paths` | 收编为禁用记录的数量 |
| `drop_missing_disabled` | `ids` | 移除失效记录的数量 |

错误一律以字符串形式返回，前端 `errorText()` 统一转成可读文案。

## 数据流

1. `list_fonts` 并发枚举两个注册表源，逐条解析字体元数据、文件大小与创建时间，按名称排序返回。
2. `applyFilter()` 依据搜索词、侧栏视图（全部 / 收藏 / 停用 / 缺失 / 字体单）、筛选条件与排序，
   产出 `state.filtered`。
3. `rebuild()` 按当前分组依据把结果切成桶，再按字族聚合，生成虚拟列表的行模型（分组带 / 字族行 /
   字体行），同时记录 `rowKeys` / `rowHeights` / `rowOffsets` 供滚动与吸顶使用。
4. 滚动时虚拟列表只渲染可视区间；分组带的吸顶标题由 `computePin()` 依据行偏移计算。
5. 预览模式下 `PreviewPool` 在行进入可视区时为每个 face 注册 `@font-face`，加载失败会回退并记录原因。

## 分组与吸顶

- 分组依据：不分组 / 启用状态 / 样式类型 / 可修改性 / 安装位置 / 安装时间。
- 不分组时列表完全平铺（不含分组带），排序直接作用于全量结果。
- 分组生效时，每个桶一条分组带；桶内沿用当前排序。
- 吸顶标题与列表内分组带共用 `.group` 结构与 `.group__sign`（加号 / 减号），
  展开状态每次滚动同步。
- 收起被吸顶的分组时，会把该组标题的偏移写回 `scrollTop`，避免内容塌缩后视口跳到下一组。

## 设置与字体单

- `config.ini`：`viewMode`、`theme`、`previewText`、`language`、`detailOpen`。
- `library.json`：`favorites`（字体 id 列表）与 `collections`（名称、标记色、字体 id 列表）。
- 两者都在 `%USERPROFILE%\.FontFox\`；写入用 220ms 防抖，退出前不额外 flush（写入即时落盘）。

## 语言包

- 唯一源文件在 `langBuild/<id>.ini`，`[section]` + `key=value`，`{name}` 为插值占位。
- 构建期复制到 `target/<profile>/lang/` 并随 `bundle.resources` 打进安装目录。
- 运行时由 Rust 解析成 `{ "section.key": "文本" }` 交给前端；**没有内置回退**，缺失键会直接
  显示键名，便于发现漏翻。

## 构建

- 前端：`vite build` → `dist/`，由 Tauri 打包进应用资源。
- 后端：`cargo build`（debug/release），`build.rs` 负责语言包兜底复制。
- 安装包：`tauri build` 产出 NSIS（每机器安装，`installer-hooks.nsh` 负责卸载清理）。