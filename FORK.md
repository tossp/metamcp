# 分叉维护策略

本仓库是 [`metatool-ai/metamcp`](https://github.com/metatool-ai/metamcp)
的独立维护分叉，长期集成与发布基线为 `ts` 分支。

## Remote 与分支职责

- `origin` 为 `https://github.com/tossp/metamcp.git`，承载维护代码、PR、
  release 以及 `ghcr.io/tossp/metamcp` 镜像通道。
- `upstream` 为 `https://github.com/metatool-ai/metamcp.git`，仅作为比较和
  选择性吸纳变更的只读来源。
- `ts` 是长期维护与集成分支。上游变更只能通过受审查的分支和 PR 进入
  `ts`。
- `upstream-mirror` 是上游 `ai-dev` 分支的干净镜像，不得包含 fork 专属
  commit，也不会自动合入 `ts`。

如果上游变更默认开发分支，应先通过受审查的 PR 同步修改本文和同步
workflow，再改变 mirror 来源。

## Mirror 同步

`.github/workflows/sync-upstream-mirror.yml` 每周运行一次，也可手工触发。
它只 fetch 上游 `ai-dev`，确认当前 `upstream-mirror` tip 是其祖先，然后
执行 `ff-only` 更新。workflow 绝不 force-push。

等价的本地命令为：

```bash
git fetch origin upstream-mirror
git fetch upstream ai-dev
git switch --detach origin/upstream-mirror
git merge --ff-only upstream/ai-dev
git push origin HEAD:upstream-mirror
```

建议约每周执行一次，或在评估上游变更前手工执行。若 ancestry 检查或
fast-forward 失败，应停止同步并创建维护 issue 或 PR，附上双方 SHA 供
审查。不得自动 merge、reset、重建或 force-push mirror；若上游改写历史，
任何恢复动作都需要维护者明确裁决。

上游 tag 不自动镜像。本 fork 只按需创建 tag：release tag 使用
`v<semver>`，并且必须指向可从 `origin/ts` 或保留的旧 `origin/main` 主线
到达的 commit。

## 吸纳上游变更

`upstream-mirror` 仅作为比较来源。从 `origin/ts` 创建 topic branch，选择
或重新实现所需变更，完成本 fork 的检查后再经审查合并。Mirror 同步绝不
更新 `ts`。

## CI 与镜像通道

面向 `ts` 的 PR 运行名称稳定的 `lint`、`check-types`、`build` 和
`backend-tests` jobs。待这些 checks 至少实际运行一次并在 GitHub 注册后，
维护者再将其配置为 required checks；这是 GitHub 控制面步骤，不能仅靠
仓库文件提前完成。

`ts` push 成功后只发布 `ghcr.io/tossp/metamcp:ts`，绝不更新 `latest`。
从 `origin/ts` 或 `origin/main` 可达的 `v<semver>` tag 会发布版本号、
major/minor、major 和 `latest` tags。发布镜像覆盖 `linux/amd64`、
`linux/arm64`，并携带 provenance、SBOM 和可记录的 digest。

首次 `:ts` 镜像只有在发布 workflow 于 `ts` 成功后才存在。切换顺序必须为：

1. 将受审查的维护基线 PR 合入 `ts`。
2. 确认 `Publish container image` workflow 成功，并为
   `ghcr.io/tossp/metamcp:ts` 报告 digest。
3. 此后才 pull 或重新部署引用 `:ts` 的 Compose 配置。

在第 2 步完成前，现有部署必须保留当前可工作的镜像，不能假定 fork 镜像
已经可用。
