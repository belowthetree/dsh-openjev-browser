# dsh-openjev-browser

[中文版 README](README.md)

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

The plugin **ships no model weights and no python runtime** — both are
user-deployed. The settings page (*Deployment* card) carries a **copy-paste
agent prompt**: hand it to any DSH agent and it performs the whole setup
(python env + model + smoke test) and reports back the two paths to fill in.
The underlying spec lives in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

After deployment the plugin detects, in order:

1. a running decision service at `openjevUrl` (default `http://127.0.0.1:8080`);
2. a local artifact (`config.modelDir`, `$OPENJEV_ARTIFACT`, `$OPENJEV_MODEL`,
   `~/.openjev/models/OpenJev-4B`, `~/.dsh/openjev/models/OpenJev-4B`)
   validated against `manifest.json` + `COMPLETE`;
3. a python interpreter with the `openjev` package to serve that artifact —
   resolution order: `config.pythonPath` → `$OPENJEV_PYTHON` → `python` on
   PATH. The plugin then **auto-starts** `python -m openjev.runtime.server`
   on first use.

Goal-driven tools (`browser_pick`, and the `goal` path of click/type/text/
scroll/screenshot) fail soft with structured setup guidance when no model is
available; selector-based calls keep working without one.

### Deploying (2 minutes of agent time + ~8 GB of download)

Settings → OpenJev Browser → *Deployment* → **Copy deployment prompt** →
paste into a fresh DSH session. The prompt instructs the agent to:

- create a python 3.12 env **outside the DSH session workspace** (sandbox
  per-executable write confinement makes workspace python almost unusable),
  at `%USERPROFILE%\.dsh\openjev\runtime` by default;
- `uv pip install` torch (CPU or CUDA 12.8 index) and
  `openjev[serve] @ git+https://github.com/ejhshen/OpenJev.git`
  (the PyPI name `openjev` is an unrelated squatter — git only);
- download HF repo `shenjunhao/OpenJev-4B` (~8 GB) and verify it against the
  artifact manifest (`COMPLETE` == sha256 of `manifest.json`, exact sizes);
- smoke-test `python -m openjev.runtime.server --artifact <dir>` until
  `/health` returns ready;
- tell you the **Python path** and **model directory** to save in settings.

CLI equivalents for detection afterwards:

```bash
node lib/setup.js detect          # probe service / artifact / python
node lib/setup.js print-config    # emit a cordis.patch.yml config snippet
```

### Spawned-child temp dirs (Windows sandbox note)

Every spawned python child gets `TMP/TEMP/TMPDIR/TORCHINDUCTOR_CACHE_DIR`
redirected into `$DSH_HOME/openjev/tmp`: the DSH host sandbox can make the
system temp dir unusable for plugin-spawned processes (torch inductor dies
with *"No usable temporary directory found"* otherwise). A `pythonPath`
pointing at an interpreter **inside the session workspace** is additionally
confined to workspace writes by the sandbox, so the plugin probes each
interpreter once and falls back to `.openjev-tmp/` beside that interpreter.

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
      modelDir: null                      # local artifact dir
      pythonPath: null                    # python with the openjev package
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
