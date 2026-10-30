# 项目约定（面向协作者与 AI 助手）

## 文档

- **所有 Markdown 文档只描述现状**：写当前行为、当前数值、当前结构；不保留过去的写法、废弃条目、
  过时截图说明或改动记录，也不写「从 A 改成 B」「旧版 / 新版」「改动前 / 改动后」这类新旧对比。
  需要追溯请查 git 提交记录。
- 规范与实现必须一致：改样式 / 组件 / 交互前先改 `docs/ui-spec.md`，再改代码；改模块或 IPC 前先改
  `docs/architecture.md`。
- 文档语言：正文简体中文；代码、标识符、路径、命令保持原文。术语沿用界面文案（「停用」「启用」）；`Inactive Fonts` 的隐藏语义只在开发文档里解释。
- 文档分工：`README.md` 面向使用者（简洁展示，由项目所有者维护）；`docs/development.md` 面向开发者
  （构建、数据位置、保护策略、边界）；`docs/architecture.md` 写模块与 IPC；`docs/ui-spec.md` 写界面规范。

## 代码

- 前端无框架：原生 DOM + 手写虚拟列表（`src/list.ts`）与悬浮滚动条（`src/scrollbar.ts`）。
- 所有系统操作走 IPC（`src-tauri/src/commands.rs`），前端不直接访问注册表或文件系统。
- 文案一律经 `t("section.key")`；`langBuild/schinese.ini` 是唯一源文件，**没有内置回退**，缺失键会显示键名。
- CSS 只用 `docs/ui-spec.md` 里的令牌（`--sp-*`、`--fs-*`、`--control-h`、`--row-h` 等），不写野值。
- 光标约定：列表行、分组带、菜单项、侧栏条目用箭头；按钮、开关、输入框清空叉、「N 个样式」标签用手型。

## 平台约束

- `src-tauri/app.manifest` **必须保持纯 ASCII**：非 ASCII 字符会让嵌入的清单失效，程序启动时报
  「并行配置不正确」。署名等文案写在 `NOTICE` / `tauri.conf.json` / 代码头注释里，不要写进清单。
- 用户可见的耗时操作（停用 / 删除）采用**本地先行 + 后台 IPC**：先改模型并重绘，失败再回滚；
  `WM_FONTCHANGE` 广播放在后台线程，不阻塞 IPC 返回。

## 验收

提交前依次执行，全部通过再交付：

```powershell
npx tsc --noEmit
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

界面改动需在真实窗口里验证（`dev.cmd` 或 `npm run tauri dev`），不要只看构建结果。

## 发布

- 包名 `fontfox`，可执行文件 `fontfox.exe`，标识符 `dev.fontfox.desktop`（发布后不再变更）。
- 用户数据在 `%USERPROFILE%\.FontFox\`（`config.ini`、`library.json`、`pending-delete.json`）。
- 许可证 Apache-2.0，第三方组件与数据来源见 `NOTICE`。