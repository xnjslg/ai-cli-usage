# Codex 和 agy 用量面板

在浏览器里查看 WSL 上 Codex 和 Antigravity CLI（agy）的历史 Token、各模型的 API 等价费用和当前账号剩余额度。agy 账号可以在网页上添加、改别名和切换。

## 启动

在平时使用这两个 CLI 的 WSL 用户下运行。已验证的版本和安装位置如下。

| 工具 | 验证版本 | 面板使用的位置 |
| --- | --- | --- |
| Node.js | 26.7.0 | PATH 中的 `node` |
| [Codex CLI](https://github.com/openai/codex) | 0.169.0 | PATH 中的 `codex` |
| [Antigravity CLI](https://antigravity.google/docs/overview?tab=cli) | 1.5.17 | `~/.local/bin/agy` |
| [ccusage](https://github.com/ccusage/ccusage/releases) | 20.1.2 | `~/.local/bin/ccusage` |
| [agy-auth](https://github.com/fikrilal/agy-auth/releases) | 0.5.3 | `~/.local/bin/agy-auth` |

从上游安装与 WSL 架构相符的工具。Ubuntu 上查询 agy 原生额度还用到 `jq` 和 `util-linux` 提供的 `script`。如果原生 agy 安装在其他位置，将 `AGY_AUTH_AGY_PATH` 设为该可执行文件的绝对路径。

克隆仓库后，在仓库根目录启动。面板只用 Node.js 内置模块。

```bash
node server.mjs
```

在 Windows 浏览器中打开[本地用量面板](http://localhost:8789/)。前台运行时按 Ctrl+C 停止。

### 后台运行

WSL 已启用 systemd 时，可以在仓库根目录安装用户服务。以下命令把启动器链接到当前工作副本，更新该工作副本后可用 `systemctl --user restart ai-cli-usage` 加载更新。

```bash
mkdir -p ~/.local/bin ~/.config/systemd/user
ln -s "$PWD/ai-cli-usage" ~/.local/bin/ai-cli-usage
install -m 644 systemd/ai-cli-usage.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-cli-usage.service
```

把 `~/.local/bin` 加入 PATH 后，在任意目录运行 `ai-cli-usage` 都可以启动面板。用户服务从 `~/.local/bin`、`/usr/local/bin` 和 `/usr/bin` 等标准路径查找程序。使用版本管理器安装 Node.js 或 Codex 时，可在 `~/.local/bin` 为对应的可执行文件建立链接。

```bash
systemctl --user status ai-cli-usage.service
journalctl --user -u ai-cli-usage.service -n 30 --no-pager
```

## 查看用量

用“Codex / agy”切换客户端。Token 合计、API 等价费用、每日图表和模型明细都随之切换。“每日 Token”用颜色区分模型，选中某一天可以查看各模型的具体数值。

默认显示上海时区本周一至今的数据，可切换到“上周”“本月”或自选日期。费用由 ccusage 按本地记录和内置单价估算，单位为美元。缺少单价的模型显示为“未定价”，其 Token 仍计入合计。

## 查看剩余额度

“当前账号剩余额度”随客户端切换。点“刷新”可以重新查询。切换统计周期只影响历史 Token 和 API 等价费用。

在 [agy 账号页](http://localhost:8789/#accounts) 可以比较各账号的模型组、剩余量和重置时间。原生 agy CLI 的读数复用 30 秒，刷新失败时会标记缓存和上次更新时间。Codex 按服务返回的额度窗口显示，有 Credits 余额时单独列出。重置时间均为北京时间。

## 添加和切换 agy 账号

1. 在 [agy 账号页](http://localhost:8789/#accounts) 点击“添加账号”，打开 Google 授权页，选择新账号。
2. 将一次性授权码粘贴回本地网页，点击“保存新账号”。账号默认显示邮箱，保存后可以改别名。如果已经在 WSL 的 agy 中登录，也可以在该账号旁点击“保存账号”。
3. 点击“切换到此账号”，再重新打开 agy 会话即可启用。只添加账号时，当前会话继续使用原账号。

## 数据与隐私

面板监听本机回环地址。历史统计由 ccusage 离线读取本机 CLI 记录。查询当前额度和 Google 授权时，相应 CLI 会使用你的账号连接服务商。账号页在本机浏览器显示邮箱、别名和额度。

agy 登录凭据由 agy-auth 使用文件存储保存在当前用户的配置目录。网页授权和原生额度查询会创建私有临时目录，任务结束后清理。仓库只包含面板源码和通用用户服务配置。
