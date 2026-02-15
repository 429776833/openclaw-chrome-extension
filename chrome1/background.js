const DEFAULT_PORT = 18792
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30000
const STALE_SESSION_TTL_MS = 15000
const STALE_TARGET_TTL_MS = 15000

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
let reconnectTimer = null
let reconnectAttempt = 0

let debuggerListenersInstalled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()
/** @type {Map<string, {tabId:number, expiresAt:number}>} */
const staleSessionToTab = new Map()
/** @type {Map<string, {tabId:number, expiresAt:number}>} */
const staleTargetToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text }).catch(() => {})
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color }).catch(() => {})
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

function setGlobalBadge(kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ text: cfg.text }).catch(() => {})
  void chrome.action.setBadgeBackgroundColor({ color: cfg.color }).catch(() => {})
  void chrome.action.setBadgeTextColor({ color: '#FFFFFF' }).catch(() => {})
}

function setTabTitle(tabId, title) {
  if (!tabId) return
  void chrome.action.setTitle({ tabId, title }).catch(() => {})
}

async function syncGlobalBadgeForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!active?.id) {
    setGlobalBadge('off')
    return
  }
  const state = tabs.get(active.id)?.state
  if (state === 'connected') {
    setGlobalBadge('on')
    return
  }
  if (state === 'connecting') {
    setGlobalBadge('connecting')
    return
  }
  setGlobalBadge('off')
}

function canAttachToUrl(url) {
  if (typeof url !== 'string' || !url) return false
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('file://') ||
    url.startsWith('ftp://')
  )
}

function scheduleReconnectAllTabs() {
  if (reconnectTimer) return
  const delay = Math.min(RETRY_BASE_MS * 2 ** reconnectAttempt, RETRY_MAX_MS)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void ensureAttachedForAllTabs('retry')
  }, delay)
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null
  const trackedTabIds = [...tabs.keys()]
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  for (const tabId of trackedTabIds) {
    void chrome.debugger.detach({ tabId }).catch(() => {})
    setBadge(tabId, 'connecting')
    setTabTitle(tabId, 'OpenClaw Browser Relay: disconnected (auto-retry enabled)')
  }
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()
  staleSessionToTab.clear()
  staleTargetToTab.clear()
  setGlobalBadge('connecting')
  scheduleReconnectAllTabs()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const now = Date.now()
  for (const [id, entry] of staleSessionToTab.entries()) {
    if (entry.expiresAt <= now) staleSessionToTab.delete(id)
  }
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  const stale = staleSessionToTab.get(sessionId)
  if (stale) return { tabId: stale.tabId, kind: 'stale-main' }
  return null
}

function getTabByTargetId(targetId) {
  const now = Date.now()
  for (const [id, entry] of staleTargetToTab.entries()) {
    if (entry.expiresAt <= now) staleTargetToTab.delete(id)
  }
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  const stale = staleTargetToTab.get(targetId)
  if (stale) return stale.tabId
  return null
}

function isTabNotFoundError(err) {
  const message = String(err instanceof Error ? err.message : err || '').toLowerCase()
  return (
    message.includes('tab not found') ||
    message.includes('no tab with given id') ||
    message.includes('cannot find tab') ||
    message.includes('no tab with id')
  )
}

async function isLiveTabId(tabId) {
  if (!tabId) return false
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  return Boolean(tab?.id)
}

async function resolveLiveTabIdForCommand(initialTabId, opts = {}) {
  const allowActiveFallback = opts.allowActiveFallback !== false

  if (initialTabId && (await isLiveTabId(initialTabId))) {
    return initialTabId
  }

  if (initialTabId && tabs.has(initialTabId)) {
    await detachTab(initialTabId, 'stale-tab')
  }

  if (allowActiveFallback) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (active?.id) {
      await ensureAttachedToTabId(active.id, 'command-recover')
      if (tabs.get(active.id)?.state === 'connected') return active.id
    }
    await ensureAttachedForAllTabs('command-recover-all')
  }
  if (!allowActiveFallback) return null

  for (const [id, tab] of tabs.entries()) {
    if (tab.state !== 'connected') continue
    if (await isLiveTabId(id)) return id
    await detachTab(id, 'stale-tab')
  }

  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sessionId = `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  setTabTitle(tabId, 'OpenClaw Browser Relay: attached (auto mode)')

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  void syncGlobalBadgeForActiveTab()
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId) {
    staleSessionToTab.set(tab.sessionId, {
      tabId,
      expiresAt: Date.now() + STALE_SESSION_TTL_MS,
    })
  }
  if (tab?.targetId) {
    staleTargetToTab.set(tab.targetId, {
      tabId,
      expiresAt: Date.now() + STALE_TARGET_TTL_MS,
    })
  }
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  void syncGlobalBadgeForActiveTab()
  setTabTitle(tabId, 'OpenClaw Browser Relay: waiting for auto-attach')
}

async function ensureAttachedToTabId(tabId, source = 'auto') {
  if (!tabId) return
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab?.id) return
  if (!canAttachToUrl(tab.url || '')) return

  const existing = tabs.get(tab.id)
  if (existing?.state === 'connecting' || existing?.state === 'connected') return

  tabs.set(tab.id, { state: 'connecting' })
  setBadge(tab.id, 'connecting')
  void syncGlobalBadgeForActiveTab()
  setTabTitle(tab.id, 'OpenClaw Browser Relay: auto-attaching...')

  try {
    await ensureRelayConnection()
    await attachTab(tab.id)
    reconnectAttempt = 0
  } catch (err) {
    tabs.delete(tab.id)
    setBadge(tab.id, 'error')
    void syncGlobalBadgeForActiveTab()
    setTabTitle(tab.id, 'OpenClaw Browser Relay: relay not running (open options for setup)')
    void maybeOpenHelpOnce()
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`auto-attach failed (${source})`, message, nowStack())
    scheduleReconnectAllTabs()
  }
}

async function ensureAttachedForActiveTab(source = 'auto') {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!active?.id) return
  await ensureAttachedToTabId(active.id, source)
}

async function ensureAttachedForAllTabs(source = 'auto') {
  const allTabs = await chrome.tabs.query({})
  const tasks = []
  for (const tab of allTabs) {
    if (!tab?.id) continue
    tasks.push(ensureAttachedToTabId(tab.id, source))
  }
  if (tasks.length === 0) return
  await Promise.allSettled(tasks)
}

async function getDefaultConnectedTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (active?.id && tabs.get(active.id)?.state === 'connected') {
    return active.id
  }

  for (const [id, tab] of tabs.entries()) {
    if (tab.state !== 'connected') continue
    if (await isLiveTabId(id)) return id
    await detachTab(id, 'stale-tab')
  }
  return null
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const byTarget = targetId ? getTabByTargetId(targetId) : null
  const hasExplicitAffinity = Boolean(bySession || byTarget || sessionId || targetId)
  const tabId = bySession?.tabId || byTarget || (hasExplicitAffinity ? null : await getDefaultConnectedTabId())

  const resolvedTabId = await resolveLiveTabIdForCommand(tabId, {
    allowActiveFallback: !hasExplicitAffinity,
  })
  if (!resolvedTabId) throw new Error(`No attached tab for method ${method}`)
  const resolvedTabState = tabs.get(resolvedTabId)
  if (targetId && resolvedTabState?.targetId && resolvedTabState.targetId !== targetId) {
    console.warn(
      '[relay] targetId mismatch bridged',
      JSON.stringify({
        method,
        tabId: resolvedTabId,
        requestedTargetId: targetId,
        currentTargetId: resolvedTabState.targetId,
      })
    )
  }

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId: resolvedTabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : resolvedTabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : resolvedTabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const sessionBinding = sessionId ? getTabBySessionId(sessionId) : null
  if (sessionId && sessionBinding && sessionBinding.tabId !== resolvedTabId) {
    throw new Error(`Session ${sessionId} is not attached to tab ${resolvedTabId}`)
  }
  const debuggerSession = sessionBinding?.kind === 'child' ? { ...debuggee, sessionId } : debuggee

  try {
    return await chrome.debugger.sendCommand(debuggerSession, method, params)
  } catch (err) {
    if (!isTabNotFoundError(err)) throw err

    console.warn(
      '[relay] tab-not-found during command',
      JSON.stringify({ method, resolvedTabId, sessionId: sessionId || null, targetId: targetId || null })
    )
    await detachTab(resolvedTabId, 'tab-not-found')
    const staleTab = await chrome.tabs.get(resolvedTabId).catch(() => null)
    if (staleTab?.id) {
      await ensureAttachedToTabId(resolvedTabId, 'tab-not-found-reattach')
      if (tabs.get(resolvedTabId)?.state === 'connected') {
        const retryDebuggee = { tabId: resolvedTabId }
        if (!sessionId || sessionBinding?.kind !== 'child') {
          console.warn('[relay] retrying command on reattached tab', JSON.stringify({ method, resolvedTabId }))
          return await chrome.debugger.sendCommand(retryDebuggee, method, params)
        }
      }
    }

    if (hasExplicitAffinity) {
      console.warn(
        '[relay] strict-affinity command failed after tab loss',
        JSON.stringify({ method, sessionId: sessionId || null, targetId: targetId || null })
      )
      throw new Error(
        `Target for method ${method} disappeared and affinity is strict (session=${sessionId || 'none'}, target=${targetId || 'none'})`
      )
    }

    await ensureAttachedForAllTabs('tab-not-found-recover')
    const retryTabId = await getDefaultConnectedTabId()
    if (!retryTabId || retryTabId === resolvedTabId) throw err

    const retryDebuggee = { tabId: retryTabId }
    return await chrome.debugger.sendCommand(retryDebuggee, method, params)
  }
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.targetInfoChanged' && params?.targetInfo?.targetId) {
    const newTargetId = String(params.targetInfo.targetId)
    if (newTargetId && tab.targetId !== newTargetId) {
      const oldTargetId = tab.targetId || ''
      if (oldTargetId) {
        staleTargetToTab.set(oldTargetId, {
          tabId,
          expiresAt: Date.now() + STALE_TARGET_TTL_MS,
        })
      }
      tab.targetId = newTargetId
      tabs.set(tabId, tab)
      console.warn(
        '[relay] targetId changed',
        JSON.stringify({ tabId, oldTargetId: oldTargetId || null, newTargetId })
      )
    }
  }

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return
  void detachTab(tabId, reason)
  scheduleReconnectAllTabs()
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) {
    void ensureAttachedToTabId(tab.id, 'click')
    return
  }
  void ensureAttachedForActiveTab('click')
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncGlobalBadgeForActiveTab()
  void ensureAttachedToTabId(tabId, 'activated')
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!('url' in changeInfo) && changeInfo.status !== 'complete') return
  if (tab?.active) void syncGlobalBadgeForActiveTab()
  void ensureAttachedToTabId(tabId, 'updated')
})

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab?.id) return
  void ensureAttachedToTabId(tab.id, 'created')
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabs.has(tabId)) return
  void detachTab(tabId, 'tab-closed')
})

chrome.runtime.onInstalled.addListener(() => {
  // Useful: first-time instructions.
  void chrome.runtime.openOptionsPage().catch(() => {})
  void syncGlobalBadgeForActiveTab()
  void ensureAttachedForAllTabs('installed')
})

chrome.runtime.onStartup.addListener(() => {
  void syncGlobalBadgeForActiveTab()
  void ensureAttachedForAllTabs('startup')
})
