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
pnpm build     # esbuild -> lib/
```

Then register the bundle directory with DSH (see `cordis.patch.yml`):

```yaml
- insert:
  - id: openjev-browser
    name: dsh-openjev-browser
```

## Model setup

The plugin **ships no model weights**. After install it detects, in order:

1. a running decision service at `openjevUrl` (default `http://127.0.0.1:8080`);
2. a local artifact (`config.modelDir`, `$OPENJEV_ARTIFACT`, `$OPENJEV_MODEL`,
   `~/.openjev/models/OpenJev-4B`, `~/.dsh/openjev/models/OpenJev-4B`)
   validated against `manifest.json` + `COMPLETE`;
3. a python interpreter with the `openjev` package (`config.pythonPath`,
   `$OPENJEV_PYTHON`, `python` on PATH) to serve that artifact — the plugin
   then **auto-starts** `python -m openjev.runtime.server` on first use.

Goal-driven tools (`browser_pick`, and the `goal` path of click/type/text/
scroll/screenshot) fail soft with structured setup guidance when no model is
available; selector-based calls keep working without one.

### Downloading the model (~8 GB)

```bash
node lib/setup.js download --dir D:\models\OpenJev-4B   # resumable
node lib/setup.js detect                                 # verify
node lib/setup.js print-config                           # emit config snippet
```

or set `HF_ENDPOINT` style mirrors by pointing `--repo` elsewhere. Downloads
are validated against the artifact manifest before use.

### Configuration

All fields optional (defaults shown):

```yaml
- insert:
  - id: openjev-browser
    name: dsh-openjev-browser
    config:
      openjevUrl: http://127.0.0.1:8080   # existing service wins if reachable
      modelDir: null                      # local artifact dir (skip download if set)
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
