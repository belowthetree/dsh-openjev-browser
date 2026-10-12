# dsh-openjev-browser

Native [DSH](https://github.com/DeepSeek-AI) (cordis) plugin port of the
[`openjev-browser`](../) MCP stdio tool: model-driven browser control with a
tiny context footprint. A local [OpenJev](https://huggingface.co/shenjunhao/OpenJev-4B)
decision model reads the page and returns only the one element that matters,
so the agent never ingests the DOM.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_open` | Open a URL (auto/chrome/msedge/chromium, optional profile reuse) |
| `browser_pick` | Ask OpenJev which element accomplishes a natural-language goal |
| `browser_click` | Click by goal or CSS selector |
| `browser_type` | Type into an element chosen by goal or selector |
| `browser_text` | Read a bounded slice of text from the page or one element |
| `browser_scroll` | Scroll the page, or scroll an element into view |
| `browser_screenshot` | Return a page image (with optional goal-box highlight) |
| `browser_status` | Report model/service detection state and setup guidance |
| `browser_close` | Close the browser session |

Tool names and parameter schemas match the Python MCP server; migrate call
sites by dropping the `mcp__openjev-browser__` prefix.

## Install

```bash
pnpm install   # or: pnpm install --ignore-scripts in a sandbox
pnpm build     # tsc (host) + esbuild (client) -> lib/
```

Then register the bundle directory with DSH (see `cordis.patch.yml`):

```yaml
- insert:
  - id: dsh-openjev-browser
    name: dsh-openjev-browser
```

## Model setup

The plugin **ships no model weights**. After install it detects, in order:

1. a running decision service at `openjevUrl` (default `http://127.0.0.1:8080`);
2. a local artifact (`config.modelDir`, `$OPENJEV_ARTIFACT`, `$OPENJEV_MODEL`,
   `~/.openjev/models/OpenJev-4B`, `~/.dsh/openjev/models/OpenJev-4B`)
   validated against `manifest.json` + `COMPLETE`;
3. a python interpreter with the `openjev` package to serve that artifact —
   resolution order: `config.pythonPath` → the **managed runtime** (below) →
   `$OPENJEV_PYTHON` → `python` on PATH. The plugin then **auto-starts**
   `python -m openjev.runtime.server` on first use.

Goal-driven tools (`browser_pick`, and the `goal` path of click/type/text/
scroll/screenshot) fail soft with structured setup guidance when no model is
available; selector-based calls keep working without one.

### Managed python runtime (no user-side setup)

The plugin can bootstrap a fully self-contained interpreter — **users never
deploy python themselves**. From the settings page (*Runtime (Python)* card)
press *Install runtime*; it downloads, into `$DSH_HOME/openjev/`:

| Piece | What | Size |
| --- | --- | --- |
| `bin/uv` | [astral-sh/uv](https://github.com/astral-sh/uv) env manager | ~15 MB |
| `runtime/` | standalone CPython 3.12 venv (fetched by uv) | ~120 MB |
| packages | `torch` (CPU build by default) + `openjev[serve]` from git | ~400 MB |

The PyTorch build is selectable (CPU / CUDA 12.6 / CUDA 12.8 — CUDA ~2.5 GB
larger, faster on NVIDIA GPUs), and the openjev install source is
configurable (`runtimeSpec`, default
`openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git` — the PyPI name
`openjev` is an unrelated squatter, so installs go through git).

Every spawned child (uv, python, the decision server) gets `TMP/TEMP/
TMPDIR/TORCHINDUCTOR_CACHE_DIR` redirected into `$DSH_HOME/openjev/tmp`: the
DSH host sandbox can make the system temp dir unusable for plugin-spawned
processes (torch inductor dies with *"No usable temporary directory found"*
otherwise). One exception: a `pythonPath` pointing at an interpreter
**inside the session workspace** is confined to workspace writes by the
sandbox, so the plugin probes each interpreter once and, when the shared tmp
dir is not writable from it, falls back to `.openjev-tmp/` beside that
interpreter.

CLI/API equivalents: `POST /dsh-openjev-browser/api/runtime/install`
(cancellable via `.../runtime/cancel`, poll `GET .../runtime`).

### Downloading the model (~8 GB)

From the **settings page** (Settings → OpenJev Browser, or the plugin card):
pick a directory, press *Start download*, watch progress, cancel any time —
a validated download becomes the model directory automatically. You can also
point *Model directory* at any already-downloaded model (an OpenJev artifact,
or a folder with `config.json` / `*.safetensors`).

From the CLI:

```bash
node lib/setup.js download --dir D:\models\OpenJev-4B   # resumable
node lib/setup.js detect                                 # verify
node lib/setup.js print-config                           # emit config snippet
```

or set `HF_ENDPOINT` style mirrors by pointing `--repo` elsewhere. Downloads
are validated against the artifact manifest before use.

### Settings page & precedence

The client half registers a settings section (`OpenJev Browser`) backed by a
loopback-only API at `/dsh-openjev-browser/api`. Values saved there live in
`$DSH_HOME/dsh-openjev-browser.settings.json` and apply **immediately**
(no restart) — with precedence:

```
built-in defaults  <  loader patch config  <  settings file
```

The settings file is plain JSON; delete it to fall back to patch config.

### Configuration

All fields optional (defaults shown):

```yaml
- insert:
  - id: dsh-openjev-browser
    name: dsh-openjev-browser
    config:
      openjevUrl: http://127.0.0.1:8080   # existing service wins if reachable
      modelDir: null                      # local artifact dir (skip download if set)
      pythonPath: null                    # python with the openjev package
      runtimeDir: null                    # managed venv (default $DSH_HOME/openjev/runtime)
      runtimeSpec: "openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git"
      runtimeTorchIndex: https://download.pytorch.org/whl/cpu   # or .../whl/cu126, .../whl/cu128
      autoStartServer: true               # spawn the server when 2+3 hold
      serverPort: 8080
      serverStartupTimeoutMs: 240000      # first Triton JIT can take minutes
      browser: auto                       # auto|chrome|msedge|chromium
      headed: false
      userDataDir: null                   # reuse a logged-in profile
      maxCandidates: 80
      includeOffscreen: true
      maxNameLength: 90
      viewport: [1280, 900]
      timeoutMs: 30000
      debugDir: null                      # dump withheld observations here
```

## Screenshots

`browser_screenshot` returns the image inline when the active model route
accepts image input (checked via `llm.resolveModelInfo`), otherwise the tool
degrades to metadata text with `[image unavailable: ...]` and a hint to pass
`path` to save the file.

## Development

```bash
pnpm typecheck
node scripts/smoke.mjs   # mock-ctx smoke: registers tools, opens about:blank
```

Architecture and the Python→Node porting notes: [`../docs/dsh-plugin-plan.md`](../docs/dsh-plugin-plan.md).

## License

MIT (c) 2026 Junhao Shen — see [LICENSE](LICENSE).
