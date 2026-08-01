# Lynage 基准测试题目

## 设计目标

基准测试使用**精确 + 反常识**的测试题，确保模型**必须检索原文**才能答对，无法靠常识或关键词猜测。

三个设计约束：

1. **反常识选择** — 每个技术决策的正确答案违背主流惯例（如组件库用 styled-components 而非 CSS Modules）。模型靠常识推理必然答错。

2. **精确细节** — 每道题需要原文中的精确事实（具体库、具体 API、具体配置），这些细节不存在于模型训练常识中。

3. **含糊表述** — 问题只给主题线索，不含答案关键词。检索必须依赖语义导航（AI 摘要 + 阶段树），而非关键词直接命中。

## 反常识事实集

| # | 主题 | 反常识决策 | 常识预期（错误答案） | 精确细节（需读原文） |
|---|------|-----------|---------------------|---------------------|
| 1 | 样式方案 | styled-components | CSS Modules / Tailwind | ThemeProvider 传递主题 |
| 2 | 数据库 | MongoDB | PostgreSQL | M10 实例，3 节点副本集 |
| 3 | 部署 | Vercel | Docker | Functions 而非 Edge Functions |
| 4 | 状态管理 | Redux Toolkit | Zustand | createSlice + RTK Query |
| 5 | 认证 | Supabase Auth | NextAuth | 邮箱验证 + JWT，7 天过期 |
| 6 | Monorepo | Nx | Turborepo | affected 命令增量构建 |
| 7 | 测试框架 | Cypress 组件测试 | Vitest | 组件测试而非 e2e |
| 8 | 路由 | TanStack Router | App Router | search params 类型安全 |
| 9 | 构建工具 | esbuild | Vite | 自定义 plugin 提取 CSS |
| 10 | 设计系统 | Ant Design 定制 | shadcn/ui | ConfigProvider 定制 token |

## 测试题目

以下问题用于基准测试。每个问题**不含答案关键词**，只给主题线索；模型必须从检索到的原文中提取精确事实。

---

### Q1. 样式方案

**对话中的决策：** 团队讨论组件库样式方案时，评估了 CSS Modules、Tailwind 和 styled-components。虽然 CSS Modules 更主流，但最终决定采用 styled-components，因为需要动态主题能力。主题通过 ThemeProvider 从根组件注入。

**问题：** 关于组件库的样式方案，团队做了一个和主流做法不同的选择。具体用了什么方案？主题是怎么传递到组件里的？

**正确答案：** styled-components，通过 ThemeProvider 传递主题
**常识陷阱：** CSS Modules / Tailwind（模型常识别）
**精确要点：** ThemeProvider（原文独有，不在常识中）

---

### Q2. 数据库

**对话中的决策：** 团队评估 PostgreSQL、SQLite、MongoDB。尽管 PostgreSQL 是关系型主流，但团队数据以非结构化文档为主，最终选择 MongoDB，部署在 Atlas M10 实例，配置 3 节点副本集。

**问题：** 关于数据库选型，团队最后选了什么？用的是哪种部署实例？

**正确答案：** MongoDB，Atlas M10 实例
**常识陷阱：** PostgreSQL（模型常识别）
**精确要点：** M10 实例、3 节点副本集

---

### Q3. 部署方案

**对话中的决策：** 团队比较 Docker 自托管和 Vercel。考虑到团队没有运维人员，最终选择 Vercel，使用 Functions（非 Edge Functions）承载 API。

**问题：** 部署方案上，团队没有选择容器化。最终用了什么平台？API 是用哪种 Functions 承载的？

**正确答案：** Vercel，Functions（非 Edge Functions）
**常识陷阱：** Docker / Kubernetes（模型常识别）
**精确要点：** Functions 而非 Edge Functions

---

### Q4. 状态管理

**对话中的决策：** 团队对比 Zustand 和 Redux Toolkit。尽管 Zustand 更轻量，但项目需要复杂的异步状态流，最终选择 Redux Toolkit，使用 createSlice 定义 reducer、RTK Query 管理服务端状态。

**问题：** 状态管理没有用轻量方案。最终选了哪个库？异步状态用什么方式管理？

**正确答案：** Redux Toolkit，createSlice + RTK Query
**常识陷阱：** Zustand（模型常识别）
**精确要点：** createSlice、RTK Query

---

### Q5. 认证方案

**对话中的决策：** 团队对比 NextAuth 和 Supabase Auth。由于需要自定义用户表结构，最终选择 Supabase Auth，使用邮箱验证 + JWT，token 有效期 7 天。

**问题：** 认证方案没有选生态最大的那个。最终用了什么？验证方式和 token 有效期是什么？

**正确答案：** Supabase Auth，邮箱验证 + JWT，7 天过期
**常识陷阱：** NextAuth（模型常识别）
**精确要点：** 邮箱验证、JWT、7 天

---

### Q6. Monorepo

**对话中的决策：** 团队比较 Turborepo 和 Nx。由于需要跨包的类型检查依赖图，最终选择 Nx，使用 affected 命令做增量构建和测试。

**问题：** Monorepo 没有选 Turborepo。最终用了什么工具？增量构建用的什么命令？

**正确答案：** Nx，affected 命令
**常识陷阱：** Turborepo（模型常识别）
**精确要点：** affected 命令

---

### Q7. 测试框架

**对话中的决策：** 团队评估 Vitest 和 Cypress。由于组件交互逻辑复杂，最终选择 Cypress 的组件测试（而非 e2e）覆盖 UI 层，单元测试仍用 Vitest。

**问题：** 测试策略上，UI 组件用的是什么工具测试？是哪种测试类型？

**正确答案：** Cypress 组件测试（非 e2e）
**常识陷阱：** Vitest / Jest（模型常识别为单元测试）
**精确要点：** 组件测试而非 e2e

---

### Q8. 路由方案

**对话中的决策：** 团队对比 App Router 和 TanStack Router。由于需要搜索参数的类型安全，最终选择 TanStack Router。

**问题：** 路由没有用框架内置的方案。最终用了什么？选择它的核心理由是什么？

**正确答案：** TanStack Router，search params 类型安全
**常识陷阱：** Next.js App Router（模型常识别）
**精确要点：** search params 类型安全

---

### Q9. 构建工具

**对话中的决策：** 团队评估 Vite 和 esbuild。由于需要极细粒度的打包控制，最终直接使用 esbuild，并编写自定义 plugin 处理 CSS 提取。

**问题：** 构建没有用 Vite。最终用了什么工具？CSS 是怎么处理的？

**正确答案：** esbuild，自定义 plugin 提取 CSS
**常识陷阱：** Vite（模型常识别）
**精确要点：** 自定义 plugin、CSS 提取

---

### Q10. 设计系统

**对话中的决策：** 团队对比 shadcn/ui 和 Ant Design。由于需要企业级组件库的完整组件集，最终选择 Ant Design 并通过 ConfigProvider 定制设计 token。

**问题：** 设计系统没有用 shadcn/ui。最终用了什么？主题定制用什么组件？

**正确答案：** Ant Design，ConfigProvider 定制 token
**常识陷阱：** shadcn/ui（模型常识别）
**精确要点：** ConfigProvider、design token

---

## 评估标准

对每个回答，使用 LLM-as-judge 判定：

- **accurate（准确）**：回答包含正确答案 + 精确细节，且未声称选错方案
- **hallucination（幻觉）**：回答明确声称选了常识方案（错误答案）

模型靠常识推理必错（反常识），靠关键词匹配无法答出精确细节（问题无答案词），必须检索到原文并读取精确信息才能全对。
