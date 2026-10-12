# 部署指引:Python 环境与模型

dsh-openjev-browser 只包含 Node 侧代码(浏览器自动化 + 插件逻辑)。**Python 环境与 OpenJev 模型由用户自行部署**,部署方式有两种:

1. **推荐**:把下面的「Agent 提示词」原样粘贴给任意一个 DSH 会话,让 agent 自动完成全部步骤;
2. 对照「部署规范」手工执行。

设置面板(设置 → OpenJev 浏览器 → 部署指引)内置了同样的提示词,可一键复制。

---

## Agent 提示词(复制即用)

````
请帮我部署 dsh-openjev-browser 插件所需的 OpenJev 决策模型运行环境,并严格按以下要求执行:

1. Python 环境
   - 不要把环境建在当前会话工作区内:DSH 沙箱会限制工作区内可执行文件的写权限,工作区内的 python 无法写用户目录。
   - 推荐位置:%USERPROFILE%\.dsh\openjev\runtime(Windows)或 ~/.dsh/openjev/runtime(macOS/Linux)。
   - 用 uv 创建独立环境(没有 uv 就先装 uv):uv venv --python 3.12 <runtime-dir>
   - 安装 PyTorch(按硬件二选一):
     * CPU(稳妥默认):uv pip install --python <runtime-dir>\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cpu
     * NVIDIA 显卡(CUDA 12.8):把索引换成 https://download.pytorch.org/whl/cu128
   - 安装 openjev 服务端:uv pip install --python <python> "openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git"
     注意:PyPI 上的 openjev 包名被无关项目占用,必须走 git 安装。
   - 验证:<python> -c "import openjev, fastapi, uvicorn; print('ok')"

2. 模型工件(约 8 GB)
   - 从 Hugging Face 下载 shenjunhao/OpenJev-4B 的全部文件到 %USERPROFILE%\.dsh\openjev\models\OpenJev-4B,例如:
     uv pip install --python <python> huggingface_hub 后执行
     <python> -m huggingface_hub.commands.huggingface_cli download shenjunhao/OpenJev-4B --local-dir <model-dir>
     (或直接用 hf download shenjunhao/OpenJev-4B --local-dir <model-dir>)
   - 下载后校验:目录内必须有 manifest.json 与 COMPLETE;COMPLETE 的内容 == manifest.json 文件的 sha256(十六进制小写);manifest 中列出的每个文件都存在且字节数一致。

3. 自检
   - 启动服务:<python> -m openjev.runtime.server --artifact <model-dir> --host 127.0.0.1 --port 8080
   - 轮询 GET http://127.0.0.1:8080/health,返回 {"status":"ready"} 即成功;随后停掉该进程(插件会按需自动拉起)。

4. 收尾
   - 打开 DSH 设置 → OpenJev 浏览器,填入:Python 路径 = <python 完整路径>,模型目录 = <model-dir>,保存。
   - 告诉我这两个路径,并说明每一步的结果;任何一步失败请给出原始报错。
````

---

## 部署规范

### 运行环境

| 项 | 要求 |
| --- | --- |
| Python | 3.12(3.10+ 一般可用,3.12 为上游 CI 版本) |
| 关键包 | `torch`(CPU 或 CUDA 12.8 索引)、`openjev[serve]`(git 安装,含 fastapi/uvicorn) |
| 位置 | **必须在 DSH 会话工作区之外**;推荐 `%USERPROFILE%\.dsh\openjev\runtime` |
| PyPI 注意 | `pip install openjev` 装到的是同名无关包,必须用 `openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git` |

### 模型工件格式(artifact_format_version 1)

```
<model-dir>/
  manifest.json   # {"artifact_format_version": 1, "files": {"<相对路径>": {"bytes": <字节数>}, ...}}
  COMPLETE        # 内容 = manifest.json 的 sha256(十六进制小写)
  config.json / *.safetensors / ...   # manifest 列出的全部文件,字节数必须一致
```

插件加载前会逐项校验;校验失败会在状态卡里列出原因。

### 服务契约

```
<python> -m openjev.runtime.server --artifact <model-dir> --host 127.0.0.1 --port 8080
GET  /health  -> {"status": "ready", "model": "..."}   # 就绪判据
POST /decide  -> 由插件调用(goal-driven 元素决策)
```

插件在 `autoStartServer` 开启时会用配置好的 `pythonPath` 与 `modelDir` 自动拉起并管理该进程;也可以自己常驻一个服务,把地址填进「决策服务地址」。

### 沙箱注意事项(Windows)

- DSH 会话沙箱按**可执行文件路径**隔离:位于会话工作区内的 python.exe 无法写工作区之外的目录。因此环境一律装在工作区外。
- 插件已为子进程重定向 `TMP/TEMP/TMPDIR/TORCHINDUCTOR_CACHE_DIR`;若你坚持把 python 放在工作区内,插件会自动探测并退回到解释器旁的 `.openjev-tmp/`(仅临时文件可写,装包仍受限,不推荐)。
