# MetaMCP 仓库说明

## 仓库来源与分支策略

- 来源事实：本地 `origin` 指向 GitHub fork `tossp/metamcp`；该 fork 的 GitHub `parent/source` 均为 `metatool-ai/metamcp`，本地 `upstream` remote 也指向该仓库。
- 分支事实：GitHub 当前默认分支在 `tossp/metamcp` 为 `ts`，在 `metatool-ai/metamcp` 为 `ai-dev`；本项目实际维护、集成和最终使用 `ts`，其 tracking branch 为 `origin/ts`。
- 维护策略：项目虽源自 fork，但当前完全独立维护；上游变更仅作为候选，按需评估和选择性吸纳，不以持续同步、保持分支一致或完整合并为目标。
- 分支保护：上游已有或继承的分支应尽量保持原状，便于后续比较和吸纳；默认不要在这些分支直接开发或改写历史。
- 操作限制：未经明确任务，不执行上游同步、批量 merge/rebase/reset、force-push，也不用上游状态覆盖 `ts`。
- 状态判断：本地缓存的 `origin/HEAD -> origin/ai-dev` 已与 GitHub 当前默认分支 `ts` 不一致，不能据此判断远端默认分支。

## 工具链与命令

- 这是私有的 pnpm/Turbo monorepo。统一使用 Node.js `>=24.15.0 <25` 和根目录声明的 `pnpm@11.18.0`；workspace 为 `apps/*` 与 `packages/*`，lockfile 为 v9。
- 根目录检查命令为 `pnpm lint`、`pnpm check-types` 和 `pnpm build`。`pnpm dev` 先通过 `dotenv` 加载 `.env.local`，再启动 Turbo task。
- `pnpm format` 与 `pnpm lint:fix` 会重写文件。共享 lint 规则还强制执行 Prettier 格式、import 排序和移除未使用的 import；允许以下划线开头的变量。

## 验证范围

- 根目录没有 `test` script。Backend 测试使用 `pnpm --filter backend test`，coverage 使用 `pnpm --filter backend test:coverage`。
- 根目录的 `pnpm check-types` 当前覆盖 `backend`、`frontend` 和 `@repo/zod-types`，但不覆盖全部 workspace；不得称其为全仓库类型验证。
- 验证应匹配变更边界：Backend 行为使用 Backend 测试命令；仅在实际覆盖范围内补充根目录 lint/build 或有限的类型检查。

## 架构边界

- `apps/frontend` 是运行于 12008 端口的 Next.js；`apps/backend` 是固定运行于 12009 端口的 Express。`apps/frontend/next.config.js` 将 health、OAuth/well-known、auth、tRPC、MCP proxy 和 MetaMCP 路由重写到 Backend。
- 跨应用的 tRPC contract 位于 `packages/trpc`；共享 Zod schema 位于 `packages/zod-types`。不得在应用内重复定义这些 contract。
- 在 `apps/backend/src/index.ts` 中，`/mcp-proxy/` 和 `/metamcp/` 下的请求必须绕过 `express.json()`，以保持 MCP raw stream 完整。修改 middleware 或 route 时须保留该顺序与例外。

## 运行环境

- 不同启动路径有意使用不同环境文件：本地 `pnpm dev` 读取根目录 `.env.local`，CONTRIBUTING 和 Docker Compose 流程使用根目录 `.env`。应按所选路径准备对应文件，不得假定两者已同步。
- Backend 启动需要 `BETTER_AUTH_SECRET` 和 `APP_URL`；数据库访问及 Drizzle 命令需要 `DATABASE_URL`。
- 仓库已忽略 `.env`、`.env.local`、`.env.development.local`、`.env.test.local` 和 `.env.production.local`；不得提交这些文件。

## 数据库与副作用

- PostgreSQL/Drizzle schema 位于 `apps/backend/src/db/schema.ts`；生成的 migration 应放在 `apps/backend/drizzle`。
- `pnpm --filter backend db:generate` 读取根目录 `.env` 并生成 migration 文件；`pnpm --filter backend db:migrate` 读取根目录 `.env` 并修改所配置的数据库。仅在任务明确要求相应副作用时运行。
- `pnpm dev:docker` 和 devcontainer attach 会安装依赖并运行 migration，不是无副作用的仓库检查或验证方式。
- Docker build、容器启动和 CI 中的依赖安装必须使用提交的唯一 `pnpm-lock.yaml` 与 `--frozen-lockfile`；非交互容器安装同时设置 `CI=true`，不得在镜像构建时临时 `pnpm add` 依赖。

## 项目协作

- 项目内供人审阅的说明、规则、决策和记忆默认使用中文；命令、代码、路径、变量名、API 名和必要技术术语保留原文。
