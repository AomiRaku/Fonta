# FontFox 架构说明

本文描述当前的实现结构：模块职责、进程模型、IPC 契约与关键机制。界面规范见
[ui-spec.md](ui-spec.md)，构建、数据落点与边界见 [development.md](development.md)。

## 运行形态

- 单个 Tauri v2 进程 + 一个 WebView2 窗口，前端为无框架 TypeScript。
- 前端不直接触达文件系统或注册表，一切系统操作都通过 IPC 命令。
- 删除系统作用域字体时，主进程用 `ShellExecuteExW` + `runas` 拉起自身的一个**无窗口子进程**，
  由它完成删除；其余操作全部在普通权限下进行。
- 应用清单为 `asInvoker`；安装器是 NSIS 机器级安装，安装与卸载需要管理员权限。

## 模块

### 前端

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 应用入口：状态、渲染编排、事件绑定、启动流程 |
| `src/list.ts` | 虚拟列表（行高、偏移、可见区间、滚动锚定） |
| `src/rows.ts` | 行 DOM：字体行、字族行、分组带 |
| `src/detail.ts` | 详情面板（单字体 / 字族 / 多选 / 空态，含可变字体字重滑块） |
| `src/filtermenu.ts` | 筛选菜单（分类 tab + 选项面板 + 清除筛选） |
| `src/contextmenu.ts` | 右键菜单与二级菜单（「添加到字体单」） |
| `src/scrollbar.ts` | 悬浮滚动条（不占轨道、可拖动、可常驻） |
| `src/preview.ts` | 预览样字缓存：请求 Rust 栅格化的 PNG（data URL），供行与详情面板贴图 |
| `src/i18n.ts` | 语言包载入、`t()` 插值、静态文案替换 |
| `src/icons.ts` | SVG 图标注册、归一化（`currentColor`、去 id、展开 style） |
| `src/api.ts` | IPC 封装与错误文本化 |
| `src/types.ts` | 前后端共享的数据结构 |

### Rust

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/main.rs` | 进程入口；`--restore-fonts` 无窗口模式（卸载前恢复字体） |
| `src-tauri/src/lib.rs` | Tauri 构建、插件与命令注册、启动时重试待清理文件、监听系统主题 |
| `src-tauri/src/commands.rs` | 全部 IPC 命令实现 |
| `src-tauri/src/model.rs` | 数据模型与序列化 |
| `src-tauri/src/enumerate.rs` | 注册表枚举 → `FontEntry`，含文件元数据、保护判定与安装时间 |
| `src-tauri/src/parse.rs` | `ttf-parser` 读取 `name` / `fvar` / `GSUB`，TTC face 匹配 |
| `src-tauri/src/langs.rs` | 按字形覆盖判定语言 |
| `src-tauri/src/official.rs` | 官方字体清单与 `core_fonts.json` 匹配 |
| `src-tauri/src/ownership.rs` | 文件所有者判定（TrustedInstaller / SYSTEM） |
| `src-tauri/src/registry.rs` | 注册表读写、字体目录、`Inactive Fonts`、提权检测 |
| `src-tauri/src/inactive.rs` | `Inactive Fonts` 读写与比对（Windows 基础模式） |
| `src-tauri/src/mode.rs` | 动态安装卸载模式：注销注册表值 + 隔离文件，维护 `disabled.json` |
| `src-tauri/src/preview.rs` | 预览样字栅格化：cmap 映射、symbol 字体取样、PNG 编码与结果缓存 |
| `src-tauri/src/frame.rs` | 窗口外观：通过 DWM 设置 4px 圆角 |
| `src-tauri/src/delete.rs` | 删除、待清理清单、提权子进程入口 |
| `src-tauri/src/elevation.rs` | 提权拉起自身子进程 |
| `src-tauri/src/fontchange.rs` | `WM_FONTCHANGE` 广播（后台线程） |
| `src-tauri/src/config.rs` | `config.ini` 解析与原子写 |
| `src-tauri/src/settings.rs` | 设置校验（枚举值、默认值） |
| `src-tauri/src/library.rs` | `library.json` 读写（收藏 / 字体单） |
| `src-tauri/src/i18n.rs` | 外挂语言包解析（`section.key`） |
| `src-tauri/src/theme.rs` | 读取系统应用明暗并在变化时推事件 |
| `src-tauri/build.rs` | 编译期复制 `langBuild/*.ini` 到 `target/<profile>/lang/` |

## IPC 命令

| 命令 | 入参 | 返回 |
| --- | --- | --- |
| `list_fonts` | — | `{ fonts, scannedMs, lockedFiles }`（详情字段 `families/version/copyright` 置空，按需取） |
| `font_extras` | `ids` | `[{ id, families, version, copyright }]` |
| `render_preview` | `path, text, size, color, dpr, maxWidth?, weight?, fresh?, fallback?` | PNG data URL；缺字且不允许回退时抛 `NO_GLYPHS` |
| `set_fonts_hidden` | `ids, hidden` | `{ changed, errors }` |
| `delete_fonts` | `ids` | `{ items, elevationRequired, cancelled, removedCount, lockedCount, errors }` |
| `clean_missing` | `ids` | 同上 |
| `retry_pending_deletes` | — | 清理成功的数量 |
| `get_settings` / `save_settings` | `settings` | 设置结构 |
| `load_library` / `save_library` | `library` | 收藏与字体单 |
| `about` | — | 版本、许可证名称与全文、NOTICE 全文、配置与待清理路径 |
| `app_info` | — | 诊断用：版本、提权状态、待清理清单、受保护字体统计、字体目录 |
| `reveal_path` | `path` | 在资源管理器中定位（系统字体目录走 `shell:Fonts`） |
| `registry_location` | `scope` | 注册表路径（详情面板展示） |
| `system_theme` | — | `light` / `dark`（读 `AppsUseLightTheme`） |
| `load_language` | `id` | 解析后的语言包 |
| `list_languages` | — | exe 同级 `lang/*.ini` 的 `{ id, name }` 列表 |
| `open_devtools` | — | 打开当前窗口 DevTools（需要 tauri `devtools` feature） |
| `open_url` | `url` | 用系统浏览器打开 GitHub HTTPS 链接 |
| `restore_all_fonts` | — | 恢复全部已停用字体；失败返回错误 |
| `move_disabled_to_desktop` | `paths` | 把指定隔离文件移动到桌面，返回成功数量 |
| `move_quarantined_to_desktop` | — | 把隔离目录剩余字体移动到桌面，返回成功数量 |
| `reset_user_data` | — | 删除 `%USERPROFILE%\.FontFox\` 全部内容 |
| `restart_app` | — | 重启应用 |
| `set_disable_mode` | `mode`（`windows` / `dynamic`） | `{ mode, migrated, failed, errors }`；内部完成旧模式恢复 → 切换 → 新模式重禁用，任一步失败则回滚并保持原模式 |
| `reconcile_disabled` | — | `{ extra, missing }`：隔离目录多出的文件、清单里丢失的文件 |
| `adopt_disabled_files` | `paths` | 收编为禁用记录的数量 |
| `drop_missing_disabled` | `ids` | 移除失效记录的数量 |

错误一律以字符串形式返回，前端 `errorText()` 统一转成可读文案。

## 数据流

1. `list_fonts` 并发枚举两个注册表源，解析字体元数据、文件大小与创建时间；动态模式再把
   `disabled.json` 里的隔离字体并进列表（`exists` 指向隔离文件）。
2. 列表接口不返回 `families` / `version` / `copyright`，详情面板打开时用 `font_extras` 补齐。
3. `applyFilter()` 依据搜索词、侧栏视图（全部 / 收藏 / 停用 / 缺失 / 字体单）、筛选条件与排序，
   产出 `state.filtered`。
4. `rebuild()` 按当前分组依据把结果切成桶，再按字族聚合，生成虚拟列表的行模型（分组带 / 字族行 /
   字体行），同时记录 `rowKeys` / `rowHeights` / `rowOffsets` 供滚动与吸顶使用。
5. 滚动时虚拟列表只渲染可视区间；分组带的吸顶标题由 `computePin()` 依据行偏移计算。
6. 预览模式下可见行为每张样字调用一次 `render_preview`（命中缓存则同步贴图），Rust 侧渲染 PNG，
   WebView 不加载字体。

## 分组与吸顶

- 分组依据：不分组 / 启用状态 / 样式类型 / 可修改性 / 安装位置 / 安装时间。
- 不分组时列表完全平铺（不含分组带），排序直接作用于全量结果。
- 分组生效时，每个桶一条分组带；桶内沿用当前排序。
- 吸顶标题与列表内分组带共用 `.group` 结构与 `.group__sign`（加号 / 减号），
  展开状态每次滚动同步。
- 收起被吸顶的分组时，会把该组标题的偏移写回 `scrollTop`，避免内容塌缩后视口跳到下一组。

## 设置与字体单

- `config.ini`：`viewMode`、`theme`、`language`、`detailOpen`、`disableMode`、`disableModeNext`
  （预览文字只在会话内，不写入配置）。
- `library.json`：`favorites`（字体 id 列表）与 `collections`（名称、标记色、字体 id 列表）。
- 偏好改动 350ms 防抖后写入；字体单改动 250ms 防抖后写入；两者都用临时文件 + rename 原子落盘。
- 语言包与配置都在 `%USERPROFILE%\.FontFox\`，卸载时随目录删除。

## 语言包

- 唯一源文件在 `langBuild/<id>.ini`，`[section]` + `key=value`，`{name}` 为插值占位。
- 构建期复制到 `target/<profile>/lang/` 并随 `bundle.resources` 打进安装目录。
- 文案中的字面 `\n` 由前端 `t()` 转成换行；只有对话框正文、设置项描述 / 提示等段落元素启用 `white-space: pre-line`，其余单行控件不换行。
- 运行时由 Rust 解析成 `{ "section.key": "文本" }` 交给前端；**没有内置回退**，缺失键会直接
  显示键名，便于发现漏翻。

## 构建

- 前端：`vite build` → `dist/`，由 Tauri 打包进应用资源。
- 后端：`cargo build`（debug / release），`build.rs` 负责语言包兜底复制。
- 安装包：`tauri build` 产出 NSIS（机器级安装）。图标来自 `bundle.icon`，安装器 / 卸载器图标
  由 `nsis.installerIcon` / `uninstallerIcon` 指定；`installer-hooks.nsh` 负责卸载前的字体恢复
  与卸载后的数据目录清理。