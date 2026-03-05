# React CSR 集成方案

> **状态**: ✅ 已完成初始搭建
> **日期**: 2024-03-01

## 架构概述

采用 **Vite 嵌入 Hono** 的单仓库双包结构：

- `src/` - Hono 后端服务（保持原有结构）
- `web/` - Vite React 前端子项目
- `dist/` - 合并构建输出

## 目录结构

```
local-router/
├── src/                  # Hono 后端
│   ├── index.ts          # 入口，添加静态文件服务
│   └── ...
├── web/                  # React 前端
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx      # React 入口
│       ├── App.tsx       # 根组件
│       └── pages/        # 页面组件
│           └── Dashboard.tsx
├── docs/
│   └── react-csr-integration.md  # 本文档
├── package.json          # 根配置
└── dist/                 # 构建输出
    ├── index.js          # 后端产物
    └── web/              # 前端产物
```

## 技术栈

| 层级 | 技术 | 版本 |
|-----|------|-----|
| 后端 | Hono | ^4.12.3 |
| 后端运行时 | Bun | latest |
| 前端框架 | React | ^18.3.0 |
| 构建工具 | Vite | ^5.3.0 |
| 语言 | TypeScript | ^5.4.0 |

## 开发工作流

### Zellij（推荐 - 分屏 TUI）

使用 [Zellij](https://zellij.dev) 终端 multiplexer，提供分屏 + 标签页功能：

```bash
# 同时启动前后端（左右分屏）
bun run dev

# Zellij 快捷键
# Alt + h/j/k/l 或方向键 - 切换面板
# Alt + n             - 新建面板
# Ctrl + s            - 进入滚动模式（查看历史日志）
# Ctrl + q            - 退出
```

界面布局：
```
┌─────────────────┬─────────────────┐
│   API (后端)     │   Web (前端)     │
│   :4099         │   :5173         │
│                 │                 │
│   日志输出...    │   日志输出...    │
│                 │                 │
└─────────────────┴─────────────────┘
```

### 单独启动

```bash
# 单独启动后端
bun run dev:api

# 单独启动前端
bun run dev:web

# 构建（前后端一起）
bun run build

# 生产启动
bun run start
```

## 路由设计

| 路径 | 说明 |
|-----|------|
| `/` | Hono 健康检查 |
| `/openai/*` | OpenAI API 代理 |
| `/anthropic/*` | Anthropic API 代理 |
| `/admin/*` | React SPA 入口 |
| `/admin` | 管理面板首页（重定向到 dashboard）|

## 前后端通信

前端通过 `/api/*` 端点与后端通信：

```typescript
// 前端调用示例
const response = await fetch('/api/config')
const config = await response.json()
```

开发环境 Vite 代理自动转发到 Hono 服务。

## 构建输出

```
dist/
├── index.js              # Hono 后端（Bun 构建）
└── web/                  # React 前端（Vite 构建）
    ├── index.html
    ├── assets/
    │   ├── index-xxx.js
    │   └── index-xxx.css
    └── ...
```

## 注意事项

1. **路径隔离**: `/admin/*` 专门用于前端 SPA，避免与 API 路由冲突
2. **SPA 回退**: 所有 `/admin/*` 路径都返回 `index.html`，由 React Router 处理
3. **生产部署**: 只需部署 `dist/` 目录，包含完整的前后端代码
4. **API 代理**: 前端开发时自动代理到后端，生产环境同域部署无跨域问题

## 扩展指南

### 添加新页面

1. 在 `web/src/pages/` 创建页面组件
2. 在 `web/src/App.tsx` 添加路由配置
3. 在页面中使用 `fetch('/api/xxx')` 获取数据

### 添加 API 端点

1. 在 `src/index.ts` 或新建路由文件
2. 使用 `app.get('/api/xxx', handler)` 定义端点
3. 前端直接调用同路径

## 性能优化

- 生产构建自动代码分割
- 静态文件由 Hono 直接服务（零 Node.js 开销）
- Bun 运行时提供最优后端性能
