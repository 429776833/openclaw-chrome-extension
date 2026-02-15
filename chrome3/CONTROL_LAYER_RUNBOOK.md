# Control Layer Runbook (N-Tab Stable Execution)

This runbook is for the controller that sends CDP commands through the relay.
Goal: reduce `tab not found` and `targetId/sessionId` mismatch during UI interactions.

## Hard Rules

1. Do not cache `targetId` across steps that can mutate page state.
2. Re-fetch tabs before every step (`list/get tabs` in your controller).
3. Serialize commands per tab (one in-flight command chain per tab).
4. Use bounded cross-tab concurrency (`max 4` recommended; tune by machine load).
5. After high-risk actions (click/filter/nav), re-fetch tabs again before next action.

## Standard Step Contract

For each automation step, run this sequence:

1. Refresh target list.
2. Resolve tab by stable selector (URL/title/domain/known business key), not old `targetId`.
3. Run a lightweight liveness probe on resolved tab (`Page.getFrameTree` or equivalent).
4. Execute the step command(s).
5. If step may navigate or re-render heavily:
   - wait for completion signal (load state/network quiet/DOM ready),
   - then refresh target list and remap tab.
6. Before snapshot/read-heavy steps, validate URL against expected selector URL; if drifted, renavigate then remap.

## Recoverable Error Policy

Treat these as recoverable:

- `tab not found`
- `no tab with id`
- `debugger is not attached`
- `target closed`
- `inspected target navigated or closed`

Retry flow:

1. Immediate recovery:
   - refresh tabs,
   - remap target by selector,
   - retry once.
2. Backoff recovery:
   - sleep `200-500ms` jitter,
   - refresh/remap,
   - retry once.
3. If still failing:
   - mark this tab-step failed,
   - continue other tabs,
   - enqueue this tab for a later retry round.

## Scheduler Guidance for N Tabs

1. Keep one queue per tab.
2. Run tab queues with a global concurrency limit.
3. Batch consecutive actions on the same tab to reduce context switching.
4. Avoid unnecessary `activateTarget`/focus switches unless required by the UI.
5. If many tabs are in rapid navigation, temporarily lower concurrency.

## Recommended Logging Fields

Log at controller side for every step:

- `run_id`
- `tab_selector`
- `resolved_target_id`
- `action`
- `attempt`
- `error`
- `recovered` (bool)
- `latency_ms`

Also watch extension logs:

- `[relay] targetId changed`
- `[relay] targetId refreshed`
- `[relay] targetId mismatch bridged`
- `[relay] recoverable command failure`

## Minimal Pseudocode

```text
for step in plan_for_tab:
  refresh_tabs()
  t = resolve_tab(step.selector)
  probe(t)
  try:
    exec(step, t)
  except recoverable_error:
    refresh_tabs()
    t = resolve_tab(step.selector)
    retry_once()
    if failed:
      sleep_jitter()
      refresh_tabs()
      t = resolve_tab(step.selector)
      retry_once()
```

This policy does not guarantee zero errors, but it should significantly reduce transient target/session loss in N-tab runs.
