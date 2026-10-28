# 自绘图标

放这里的 SVG 会和 `@siemens/ix-icons` 的图标一样，构建时以字符串内联进 JS，不额外请求网络。

## 添加步骤

1. 把文件放到本目录，文件名用 kebab-case，例如 `my-star.svg`；
2. 在 `src/icons.ts` 顶部加一行导入：

   ```ts
   import myStar from "./assets/icons/my-star.svg?raw";
   ```

3. 在 `SOURCES` 表里登记，名字就是 `data-icon` / `icon()` 里用的名字：

   ```ts
   const SOURCES = {
     …,
     "my-star": myStar,
   } as const;
   ```

`IconName` 类型由这张表推导，写错名字会直接编译报错。

## Illustrator 导出

Illustrator 默认导出的 SVG 带 `<style>` + `class="st0"`，直接内联会**污染整个页面的样式**。`normalize()` 已经做了兼容：

- 展开 `<style>` 里的类规则到元素属性，然后删掉 `<style>`；
- `style="fill:#231F20"`、`fill="#231F20"` 里的颜色统一换成 `currentColor`；
- 删掉 `id` / `data-name` / 注释 / `<desc>` / `<title>`，避免同一图标多处内联时 id 冲突、出现默认 tooltip；
- 根节点只保留 `viewBox`。

所以**导出时不用刻意改 Styling 选项**，Presentation Attributes 和 Internal CSS 都能用。

推荐的导出设置：

| 选项 | 建议值 | 原因 |
|---|---|---|
| File → Export → Export As → SVG | — | 比「存储为」干净，不写 XML 声明与 Generator 注释 |
| Artboards | Use Artboards | 保证 viewBox 等于画板范围 |
| Styling | Presentation Attributes 或 Internal CSS | 两者都支持 |
| Object IDs | Minimal | id 反正会被清掉 |
| Decimal | 1–2 | 路径更短，视觉无损 |
| Fonts | **Convert to Outline** | 图标里不要留文字对象 |
| Images | Embed | 图标本就不该包含位图 |
| Responsive | 勾选 | 根节点不带固定宽高 |

## 画图约定

- **画板等于图标边界**：例如 24×24 画板，图形撑满画板并留统一安全边距（建议四周 1.5–2px），这样所有图标视觉尺寸一致。
- **不要写死颜色**：Illustrator 里用默认黑色即可，导出后会被改成 `currentColor`。**多色图标会被压成单色**。
- **只用纯色**：不要用渐变、图案、投影、发光、混合模式、3D/滤镜——这些导出后是位图或 `<filter>`，内联后无法跟随主题色。
- **文字必须转曲**：Type → Create Outlines，否则会导出 `<text>` 并依赖系统字体。
- **描边会被保留**：24 网格下建议 `stroke-width="1.5"`，端点/拐角用圆头圆角（Round Cap / Round Join）。
- 不要用剪贴蒙版、不透明度蒙版；需要合并时用 Object → Expand。
- 不要依赖 `id`（会被清掉）。

## 两种画法都支持

| 画法 | Illustrator 里怎么画 | 处理结果 |
|---|---|---|
| 填充型 | 直接铺色块 | 根节点 `fill="currentColor"`，包裹层的 `fill="none"` 被剥掉 |
| 描边型 | 只描边、不填充 | 保留 `fill="none"`，根节点补 `stroke="currentColor"` |

同一张图里填充和描边混用也可以：只要有任一路径是描边，就按描边型处理，各元素保留自己的 `fill` / `stroke`。
