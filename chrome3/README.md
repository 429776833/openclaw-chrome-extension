# OpenClaw Chrome Extension (Browser Relay, Auto-Attach)

Purpose: automatically attach OpenClaw to eligible Chrome tabs so the Gateway can automate them (via the local CDP relay server).

## Dev / load unpacked

1. Build/run OpenClaw Gateway with browser control enabled.
2. Ensure the relay server is reachable at `http://127.0.0.1:18792/` (default).
3. Install the extension to a stable path:

   ```bash
   openclaw browser extension install
   openclaw browser extension path
   ```

4. Chrome → `chrome://extensions` → enable “Developer mode”.
5. “Load unpacked” → select the path printed above.
6. Pin the extension. Active tabs will auto-attach; no manual toggle is required.

## Control Layer Stability

For N-tab orchestration and target/session stability rules, see `CONTROL_LAYER_RUNBOOK.md`.

## Options

- `Relay port`: defaults to `18792`.
