

### 本轮改动（2026-08-07 · 代码消息框去滑条 + 代码预览滚动条去白框）
- **用户需求**：①代码消息框不允许有任何滑条；②代码预览可以有滑条（代码很长超预览窗口时），但滑条不能有下边那个白色的框。
- **实现**（packages/web/src/app.css）：
  - 代码消息框 `.card.code pre`：`overflow: auto` → **`overflow: hidden`**（长代码在卡片内截断，无任何滑条；点击卡片进入预览看完整代码）。
  - 代码预览 `.viewer .vbody .codeview`：保留 `overflow: auto`（超长时有滑条），新增定制滚动条样式——`scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.25) transparent`（Firefox）+ WebKit `::-webkit-scrollbar{10px}` / `::-webkit-scrollbar-thumb`（半透明白圆角） / `::-webkit-scrollbar-track`（transparent） / **`::-webkit-scrollbar-corner { background: transparent }`（去掉右下角白色框，与深色 #282c34 背景融合）**。
- **验证**（注入 40 行×超长行代码）：消息框 pre overflow=hidden、scrollable=false（无滑条）✓；预览 codeview overflow=auto、垂直+水平均可滚动（滑条存在）✓；滚动条 corner 透明规则已应用（去白框）✓。已登记 PROJECT_LOG.md。
