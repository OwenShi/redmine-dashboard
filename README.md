# Redmine 看板

把你的 Redmine 任务变成一块可视化看板，并自动关联你在 GitLab 的 Merge Request 状态。

![看板](docs/screenshot-board.png)

![卡片上的 MR 徽标（待合并 / Draft / 已合并 / 冲突 / 未解决讨论 / CI）](docs/screenshot-mr.png)

![移动端](docs/screenshot-mobile.png)

## 它能帮你做什么

- **一屏看清手上的活**：按版本分组、按状态分列，优先级、截止日期、进度一目了然
- **自动关联 MR**：卡片上直接显示你的 GitLab MR 状态——待合并、Draft、已合并、⚠冲突、💬未解决讨论；点 `CI` 还能查流水线每个 job 的结果
- **近期动态**：最近改过哪些任务，一条时间线
- **搜索和筛选**：按 `/` 聚焦搜索，类型筛选，折叠状态会记住
- **手机也能用**：响应式布局 + 触屏优化，浏览器直接访问

## 三步跑起来

前提：电脑装了 [Node.js](https://nodejs.org)（≥14）。三条命令，三个平台（macOS / Windows / Linux）完全一样：

```bash
git clone https://github.com/OwenShi/redmine-dashboard.git
cd redmine-dashboard
node start.js
```

然后浏览器打开 **http://localhost:7788**。（macOS 的 `Redmine看板.command`、Windows 的 `start.bat` 只是这条命令的双击包装，喜欢哪个用哪个。）

第一次跑之前需要配一次凭据，见下。

## 凭据怎么配（只需一次）

看板需要知道「你是谁」才能拉你的任务。两种方式任选：

**方式一：装 redmine CLI（推荐，之后全自动）**

装好 CLI 后执行一次 `redmine auth login`。`start.js` 会自动读取它的配置，什么都不用再管。

**方式二：环境变量（不想装 CLI）**

1. 打开 Redmine 网页 → 我的帐户 → 右侧「API 访问密钥」→ 显示
2. 启动时带上：

```bash
REDMINE_URL=https://你的redmine地址 REDMINE_API_KEY=你的key node start.js
```

**想显示 MR 状态（可选）**：装 [glab CLI](https://gitlab.com/gitlab-org/cli) 并 `glab login`，或设置 `GITLAB_TOKEN` 环境变量。不配也能用，只是卡片上没有 MR 徽标。

> 凭据只存在你自己电脑上（redmine CLI / glab 的本地配置或环境变量），仓库里没有任何人的密钥。

## 日常使用

- **两个标签**：看板（按版本分组） / 近期动态（最近 N 天改动）
- **MR 徽标**：`!901 待合并` 这样的 token 就是关联的 MR，点击直达 MR 页面；右侧 `CI` 按钮弹出流水线详情（每个 job 的状态和用时，再点可刷新）；⚠红色=有冲突，💬琥珀色=有未解决讨论
- **搜索**：按 `/` 聚焦搜索框，Esc 清除；可以搜编号或标题
- **折叠**：点版本行或状态列头可以收起/展开，偏好会记住
- **刷新**：右上角同步按钮强制刷新；页面开着时每 5 分钟自动同步
- 页脚的 `b0910.x` 是构建号——怀疑页面没更新时核对它

## 常见问题

| 问题 | 处理 |
|------|------|
| 显示「MR 状态不可用」 | `glab login` 一次，或设置 `GITLAB_TOKEN`；顶部提示条有重试按钮 |
| 页面看起来是旧版本 | 核对页脚构建号；强制刷新（页面本身禁止缓存，一般不会发生） |
| 数据不是最新的 | 后端有 60 秒缓存；点右上角同步按钮立即刷新 |
| 换了一台电脑 | 凭据是跟着电脑走的，新机器重新配一次凭据即可 |

## 部署成常驻服务（可选）

不想每次手动启动，可以挂在服务器上：

**Linux**

```bash
scp -r redmine-dashboard/ user@server:~/
ssh user@server
cd redmine-dashboard
REDMINE_API_KEY=你的key REDMINE_URL=https://你的redmine nohup node server.js > board.log 2>&1 &
```

**Windows**：拷贝目录 + 装 Node.js 后，用 [NSSM](https://nssm.cc/) 注册服务（开机自启）：

```bat
nssm install redmine-board "C:\Program Files\nodejs\node.exe" "C:\redmine-dashboard\server.js"
nssm set redmine-board AppEnvironmentExtra REDMINE_URL=https://你的redmine REDMINE_API_KEY=你的key
nssm start redmine-board
```

> ⚠️ 服务器可从公网访问时，务必加访问控制（防火墙白名单 / SSH 隧道 / Nginx + Basic Auth），否则工单数据对任何能连到端口的人可见。

## 实现说明（进阶，用不上可跳过）

**issue 和 MR 怎么关联上的**：后端拉取你创建的最近 100 条 MR，前端按三级规则匹配——① issue 自定义字段「分支名称」=== MR 分支名（精确；实例相关字段，没有则自动跳过）→ ② MR 标题里的 `Refs #编号` / `Fix #编号` → ③ 分支名里的数字（如 `hotfix/101-xxx` → 101）。命中任意一级即挂徽标，命中多级去重。

**性能设计**：

| 机制 | 说明 |
|------|------|
| 并发分页 | Redmine 分页并发拉取（上限 6），约 N×RTT → 2×RTT |
| 聚合缓存 | overview/recent 结果内存缓存 60s；`?force=1` 绕过 |
| MR 缓存 | MR 列表 120s；CI 按需查询 60s |
| 两段式渲染 | issue 先渲染，MR 数据到达后增量补上徽标 |

**文件说明**：

| 文件 | 作用 |
|------|------|
| `start.js` | 通用启动入口（读凭据、起服务），三平台同一命令 |
| `server.js` | 后端：代理 Redmine/GitLab API + 聚合缓存，零 npm 依赖 |
| `index.html` | 前端：单文件页面（Alpine.js + 内联 SVG） |
| `Redmine看板.command` / `start.bat` / `start.sh` | 各平台双击包装 |
| `.env.example` | 环境变量配置模板 |

## 开发注意

- `*.bat` / `*.ps1` 必须保持 **CRLF** 换行：cmd.exe 解析 LF 换行的批处理会把多行粘成一行执行。已由 `.gitattributes` 锁定入库字节，但在 macOS/Linux 上编辑这些文件时请确认编辑器不会把换行转成 LF
- 启动脚本（`.command` / `start.sh`）保持 LF
- **发版时更新页脚构建号**（`b0910.3` 这类标记）：页面以 `no-store` 下发防缓存，构建号用于核对客户端（尤其手机 Safari）是否拿到最新版本
- **移动端视觉验证须用 WebKit 引擎**（如 Playwright 的 `webkit`，与 iOS Safari 同源）：Chrome 移动模拟在 select 渲染、行高计算等细节上与 iOS 存在差异，会漏掉真机问题
