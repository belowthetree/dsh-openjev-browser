# dsh-openjev-browser

[English README](README-EN.md)

[`openjev-browser`](../) MCP stdio 工具的原生 [DSH](https://github.com/DeepSeek-AI)(cordis)插件版:以极小上下文开销实现模型驱动的浏览器操控。本地 [OpenJev](https://huggingface.co/shenjunhao/OpenJev-4B) 决策模型读取页面后只返回关键的那一个元素,agent 全程不接触 DOM。

## 工具

| 工具 | 用途 |
| --- | --- |
| `browser_open` | 打开 URL(auto/chrome/msedge/chromium,可复用已有浏览器配置) |
| `browser_pick` | 让 OpenJev 判断哪个元素能完成自然语言目标 |
| `browser_click` | 按目标或 CSS 选择器点击 |
| `browser_type` | 向按目标或选择器选中的元素输入文本 |
| `browser_text` | 读取页面或单个元素的有界文本片段 |
| `browser_scroll` | 滚动页面,或将某元素滚入视口 |
| `browser_screenshot` | 返回页面截图(可选目标元素高亮框) |
| `browser_status` | 报告模型/服务检测状态与部署指引 |
| `browser_close` | 关闭浏览器会话 |

工具名与参数 schema 与 Python MCP server 完全一致;迁移调用点只需去掉 `mcp__openjev-browser__` 前缀。

## 安装

```bash
pnpm install   # 沙箱内可用:pnpm install --ignore-scripts
pnpm build     # tsc(宿主侧)+ esbuild(客户端)-> lib/
```

然后把构建产物目录注册到 DSH(见 `cordis.patch.yml`):

```yaml
- insert:
  - id: dsh-openjev-browser
    name: dsh-openjev-browser
```

## 模型部署

插件**不附带模型权重,也不附带 Python 运行时** —— 两者均由用户自行部署。设置面板(「部署指引」卡片)内置了**可复制的 agent 提示词**:把它粘贴给任意一个 DSH 会话,agent 会自动完成全部部署(Python 环境 + 模型 + 冒烟自检)并回报需要填入的两个路径。底层规范见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

部署完成后,插件按以下顺序检测:

1. `openjevUrl`(默认 `http://127.0.0.1:8080`)上已在运行的决策服务;
2. 本地工件(`config.modelDir`、`$OPENJEV_ARTIFACT`、`$OPENJEV_MODEL`、
   `~/.openjev/models/OpenJev-4B`、`~/.dsh/openjev/models/OpenJev-4B`),
   按 `manifest.json` + `COMPLETE` 校验;
3. 装有 `openjev` 包的 Python 解释器 —— 解析顺序:`config.pythonPath` →
   `$OPENJEV_PYTHON` → PATH 上的 `python`。满足条件后插件会在首次使用时
   **自动拉起** `python -m openjev.runtime.server`。

没有可用模型时,目标驱动类工具(`browser_pick`,以及 click/type/text/scroll/screenshot 的 `goal` 路径)会软失败并返回结构化的部署指引;纯选择器调用不依赖模型,始终可用。

### 部署流程(agent 操作约 2 分钟 + 约 8 GB 下载)

设置 → OpenJev 浏览器 → 「部署指引」→ **复制部署提示词** → 粘贴到一个新的 DSH 会话。提示词会指示 agent:

- 在 **DSH 会话工作区之外**创建 Python 3.12 环境(沙箱按可执行文件路径限制写权限,工作区内的 python 几乎不可用),默认位置 `%USERPROFILE%\.dsh\openjev\runtime`;
- 用 `uv pip install` 安装 torch(CPU 或 CUDA 12.8 索引)与
  `openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git`
  (PyPI 上的 `openjev` 包名被无关项目占用 —— 必须走 git 安装);
- 下载 HF 仓库 `shenjunhao/OpenJev-4B`(约 8 GB)并按工件清单校验
  (`COMPLETE` == `manifest.json` 的 sha256,逐文件字节数一致);
- 冒烟测试 `python -m openjev.runtime.server --artifact <dir>`,直到
  `/health` 返回 ready;
- 回报 **Python 路径**与**模型目录**,由你填进设置面板保存。

事后的 CLI 检测:

```bash
node lib/setup.js detect          # 探测服务 / 工件 / python
node lib/setup.js print-config    # 输出 cordis.patch.yml 配置片段
```

### 子进程临时目录(Windows 沙箱说明)

插件拉起的每个 python 子进程都会把 `TMP/TEMP/TMPDIR/TORCHINDUCTOR_CACHE_DIR`
重定向到 `$DSH_HOME/openjev/tmp`:DSH 宿主沙箱可能让插件子进程无法使用系统
临时目录(否则 torch inductor 会报 *"No usable temporary directory found"*)。
如果 `pythonPath` 指向**会话工作区内**的解释器,沙箱会进一步把它限制为只能写
工作区,插件会对每个解释器探测一次,不可写时回退到该解释器旁的 `.openjev-tmp/`。

### 设置面板与优先级

客户端部分注册了一个设置分区(「OpenJev 浏览器」),由仅监听回环地址的 API
`/dsh-openjev-browser/api` 支撑。面板中保存的值写入
`$DSH_HOME/dsh-openjev-browser.settings.json` 并**立即生效**(无需重启),优先级:

```
内置默认值  <  loader patch 配置  <  设置文件
```

设置文件是纯 JSON;删掉它即回退到 patch 配置。

### 配置项

全部可选(示例值为默认值):

```yaml
- insert:
  - id: dsh-openjev-browser
    name: dsh-openjev-browser
    config:
      openjevUrl: http://127.0.0.1:8080   # 已有服务可达时优先使用
      modelDir: null                      # 本地工件目录
      pythonPath: null                    # 装有 openjev 包的 python
      autoStartServer: true               # 满足检测 2+3 时自动拉起服务
      serverPort: 8080
      serverStartupTimeoutMs: 240000      # 首次 Triton JIT 可能要几分钟
      browser: auto                       # auto|chrome|msedge|chromium
      headed: false
      userDataDir: null                   # 复用已登录的浏览器配置
      maxCandidates: 80
      includeOffscreen: true
      maxNameLength: 90
      viewport: [1280, 900]
      timeoutMs: 30000
      debugDir: null                      # 在此落盘被截断的观测数据
```

## 截图

当当前模型路由接受图像输入时(经 `llm.resolveModelInfo` 检查),
`browser_screenshot` 会内联返回图片;否则降级为元数据文本并附
`[image unavailable: ...]`,提示改用 `path` 参数把文件存盘。

## 开发

```bash
pnpm typecheck
node scripts/smoke.mjs   # mock-ctx 冒烟:注册工具、打开 about:blank
```

架构说明与 Python→Node 移植笔记:[`../docs/dsh-plugin-plan.md`](../docs/dsh-plugin-plan.md)。

## 许可证

MIT (c) 2026 Junhao Shen —— 见 [LICENSE](LICENSE)。
