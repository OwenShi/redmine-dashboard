# Redmine 看板

Redmine 个人任务看板：按版本与状态聚合个人任务，并自动关联 GitLab Merge Request 状态。

![看板](docs/screenshot-board.png)

![卡片上的 MR 徽标](docs/screenshot-mr.png)

![移动端](docs/screenshot-mobile.png)

## 功能特性

- **任务总览**：按版本分组、按状态分列，含优先级、截止日期与完成进度
- **MR 状态关联**：卡片上显示关联的 Merge Request（待合并 / Draft / 已合并 / 冲突 / 未解决讨论），CI 状态可按需查询流水线明细
- **近期动态**：以时间线展示近期更新的任务
- **搜索与筛选**：快捷键 `/` 聚焦搜索，支持按类型筛选，折叠偏好本地记忆
- **移动端适配**：响应式布局与触屏优化

## 快速开始

环境要求：[Node.js](https://nodejs.org) ≥ 14。

macOS / Windows / Linux 命令一致：

```bash
git clone https://github.com/OwenShi/redmine-dashboard.git
cd redmine-dashboard
node start.js
```

启动后访问 <http://localhost:7788>。

`Redmine看板.command`（macOS）与 `start.bat`（Windows）为等价的双击启动方式，可任选。

## 凭据配置（首次使用）

看板通过 API 凭据获取任务数据，以下两种方式任选其一。

### 方式一：redmine CLI（推荐）

安装 redmine CLI 并执行一次 `redmine auth login`。`start.js` 会自动读取其配置，无需其他设置。

### 方式二：环境变量

1. 在 Redmine 网页端获取密钥：**我的帐户 → API 访问密钥 → 显示**
2. 启动时通过环境变量传入：

   ```bash
   REDMINE_URL=https://你的Redmine地址 REDMINE_API_KEY=你的key node start.js
   ```

### MR 状态（可选）

显示 MR 状态需要 GitLab 凭据，以下两种方式任选其一：

**方式一：glab CLI（推荐）**

```bash
# 自建 GitLab 需指定地址；gitlab.com 可省略 --hostname
glab auth login --hostname https://你的GitLab地址
```

后端自动从 glab 的本地配置读取 GitLab 地址与 token，无需其他设置。支持的配置位置：

| 平台 | 配置路径 |
|------|----------|
| macOS | `~/Library/Application Support/glab-cli/config.yml` |
| Linux | `~/.config/glab-cli/config.yml`（遵循 `XDG_CONFIG_HOME`） |
| Windows | `%LOCALAPPDATA%\glab-cli\config.yml` |

也可用 `GLAB_CONFIG_DIR` 环境变量指定自定义位置。

**方式二：环境变量**

同时设置以下两个变量（缺一不可：只有 token 时服务端无法得知 GitLab 地址）：

```bash
GITLAB_URL=https://你的GitLab地址 GITLAB_TOKEN=你的token node start.js
```

token 在 GitLab 网页端创建：**Preferences → Access Tokens**，勾选 `read_api` 权限即可（只读，够用且安全）。

未配置时看板其他功能正常，仅不显示 MR 徽标。凭据仅保存在本机（CLI 配置文件或环境变量），仓库中不含任何密钥。

## 使用说明

- **视图切换**：看板（按版本分组）/ 近期动态（近 N 天更新）
- **MR 徽标**：点击徽标跳转 MR 页面；`CI` 按钮弹出流水线详情，包含各 job 的状态与用时；红色 ⚠ 表示存在冲突，琥珀色气泡图标表示有未解决讨论
- **搜索**：`/` 聚焦搜索框，Esc 清空，支持按编号与标题搜索
- **折叠**：点击版本行或状态列头收起/展开，偏好自动记忆
- **同步**：右上角按钮强制刷新；页面可见时每 5 分钟自动同步
- 页脚的构建号（如 `b0910.3`）用于核对页面版本

## 常见问题

| 现象 | 处理 |
|------|------|
| 显示「MR 状态不可用」 | 执行 `glab auth login --hostname 你的GitLab地址`；或同时设置 `GITLAB_URL` 与 `GITLAB_TOKEN` 环境变量 |
| 页面疑似未更新 | 核对页脚构建号后强制刷新（页面以 no-store 下发，通常不会发生） |
| 数据不是最新 | 后端有 60 秒缓存，点击右上角同步按钮立即刷新 |
| 更换电脑使用 | 凭据保存在本机，新设备需重新配置 |

## 服务器部署（可选）

如需长期运行，可部署到服务器。

### Linux

```bash
scp -r redmine-dashboard/ user@server:~/
ssh user@server
cd redmine-dashboard
REDMINE_URL=https://你的Redmine地址 REDMINE_API_KEY=你的key nohup node server.js > board.log 2>&1 &
```

### Windows

拷贝目录并安装 Node.js 后，使用 [NSSM](https://nssm.cc/) 注册为 Windows 服务（开机自启）：

```bat
nssm install redmine-board "C:\Program Files\nodejs\node.exe" "C:\redmine-dashboard\server.js"
nssm set redmine-board AppEnvironmentExtra REDMINE_URL=https://你的Redmine地址 REDMINE_API_KEY=你的key
nssm start redmine-board
```

> 注意：服务器可从公网访问时，务必添加访问控制（防火墙白名单、SSH 隧道或 Nginx + Basic Auth），否则工单数据将对所有能访问该端口的用户可见。

## 实现原理（进阶）

### issue 与 MR 的关联规则

后端拉取当前用户创建的最近 100 条 MR，前端按以下优先级匹配：

1. issue 自定义字段「分支名称」与 MR 分支名精确相等（依赖实例配置，字段不存在时自动跳过）
2. MR 标题中的 `Refs #编号` / `Fix #编号` 引用
3. 分支名中的数字段（如 `hotfix/101-xxx` 匹配 issue #101）

命中任一规则即挂载徽标，多级命中自动去重。

### 性能设计

| 机制 | 说明 |
|------|------|
| 并发分页 | Redmine 分页并发拉取（上限 6），耗时约从 N×RTT 降至 2×RTT |
| 聚合缓存 | overview / recent 结果内存缓存 60 秒，`?force=1` 绕过 |
| MR 缓存 | MR 列表缓存 120 秒；CI 查询按需加载并缓存 60 秒 |
| 两段式渲染 | 先渲染任务卡片，MR 数据到达后增量补充徽标 |

### 文件说明

| 文件 | 作用 |
|------|------|
| `start.js` | 通用启动入口：读取凭据并启动服务，三平台命令一致 |
| `server.js` | 后端：代理 Redmine / GitLab API 与聚合缓存，零 npm 依赖 |
| `index.html` | 前端：单文件页面（Alpine.js + 内联 SVG） |
| `Redmine看板.command` / `start.bat` / `start.sh` | 各平台双击启动包装 |
| `.env.example` | 环境变量配置模板 |

## 开发注意事项

- `*.bat` / `*.ps1` 必须保持 CRLF 换行：cmd.exe 解析 LF 换行的批处理会把多行合并为一条执行。已通过 `.gitattributes` 锁定入库字节，在 macOS / Linux 上编辑这些文件时需确认编辑器不会转换换行符
- `.command` / `start.sh` 保持 LF 换行
- 发版时更新页脚构建号（如 `b0910.3`）：页面以 no-store 下发防止缓存，构建号用于核对客户端（尤其是手机 Safari）是否拿到最新版本
- 移动端视觉验证须使用 WebKit 引擎（如 Playwright 的 `webkit`，与 iOS Safari 同源）：Chrome 移动模拟在 select 渲染、行高计算等细节上与 iOS 存在差异，可能遗漏真机问题
