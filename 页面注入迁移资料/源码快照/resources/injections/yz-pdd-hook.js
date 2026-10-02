;(function installYzPddHook() {
  'use strict'

  const VERSION = 1
  const existing = window.__YZ_PDD_HOOK_V1__
  if (existing && existing.version === VERSION) {
    existing.rescan?.()
    return
  }

  const runtime = {
    queue: [],
    seen: new Set(),
    mutationTypes: new Set(),
    store: null,
    im: null,
    attached: false,
    seeded: false,
    installedAt: Date.now(),
    warmupUntil: Date.now() + 8000,
    lastMessageAt: 0
  }

  function getStore() {
    const roots = [document.querySelector('#app'), ...document.querySelectorAll('[data-v-app]')]
    for (const root of roots) {
      if (!root) continue
      const vue2 = root.__vue__
      const vue3 = root.__vue_app__
      const store =
        vue2?.$store ||
        vue3?.config?.globalProperties?.$store ||
        vue3?._instance?.proxy?.$store ||
        vue3?._instance?.appContext?.config?.globalProperties?.$store
      if (store) return store
    }
    return null
  }

  function cleanUid(value) {
    return String(value || '')
      .trim()
      .replace(/-\d+-(reply|all)$/, '')
      .replace(/-0-all$/, '')
  }

  function messageKey(message, buyerId) {
    const id = String(message?.msg_id || message?.client_msg_id || '').trim()
    if (id) return `id:${id}`
    return [
      'fallback',
      buyerId,
      message?.ts || '',
      message?.type ?? '',
      String(message?.content || '').slice(0, 200)
    ].join(':')
  }

  function toPlainMessage(message, fallbackUid) {
    if (!message || typeof message !== 'object') return null
    const from = message.from && typeof message.from === 'object' ? message.from : {}
    const to = message.to && typeof message.to === 'object' ? message.to : {}
    const fromRole = String(from.role || '')
    const toRole = String(to.role || '')
    const buyerId = cleanUid(
      fromRole === 'user' ? from.uid : toRole === 'user' ? to.uid : fallbackUid
    )
    const messageId = String(message.msg_id || message.client_msg_id || '').trim()
    if (!buyerId || !messageId) return null
    return {
      msg_id: messageId,
      client_msg_id: message.client_msg_id == null ? undefined : String(message.client_msg_id),
      pre_msg_id: message.pre_msg_id == null ? undefined : String(message.pre_msg_id),
      ts: message.ts == null ? Math.floor(Date.now() / 1000) : message.ts,
      type: Number(message.type ?? 0),
      content: typeof message.content === 'string' ? message.content : '',
      from: { role: fromRole, uid: from.uid == null ? undefined : String(from.uid) },
      to: { role: toRole, uid: to.uid == null ? undefined : String(to.uid) },
      nickname: typeof message.nickname === 'string' ? message.nickname : undefined
    }
  }

  function remember(message, fallbackUid, enqueue) {
    const plain = toPlainMessage(message, fallbackUid)
    if (!plain) return false
    const buyerId = cleanUid(
      plain.from.role === 'user'
        ? plain.from.uid
        : plain.to.role === 'user'
          ? plain.to.uid
          : fallbackUid
    )
    const key = messageKey(plain, buyerId)
    if (runtime.seen.has(key)) return false
    runtime.seen.add(key)
    if (runtime.seen.size > 5000) {
      const oldest = runtime.seen.values().next().value
      if (oldest) runtime.seen.delete(oldest)
    }
    if (enqueue) {
      runtime.queue.push(plain)
      runtime.lastMessageAt = Date.now()
    }
    return true
  }

  function visit(value, fallbackUid, enqueue, depth, visited) {
    if (depth > 7 || value == null) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, fallbackUid, enqueue, depth + 1, visited)
      return
    }
    if (typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (value.msg_id && value.from) remember(value, fallbackUid, enqueue)
    if (value.message && typeof value.message === 'object') {
      remember(value.message, fallbackUid, enqueue)
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'message' || key === '__ob__' || key === '$store') continue
      if (
        key === 'messageList' ||
        key === 'lastMessage' ||
        key === 'params' ||
        key === 'payload' ||
        key === 'data' ||
        key === 'msg'
      ) {
        visit(nested, fallbackUid, enqueue, depth + 1, visited)
      }
    }
  }

  function scanConversation(row, enqueue) {
    if (!row || typeof row !== 'object') return
    const uid = cleanUid(row.userInfo?.uid || row.uid)
    if (row.lastMessage) remember(row.lastMessage, uid, enqueue)
    if (Array.isArray(row.messageList)) {
      for (const message of row.messageList) remember(message, uid, enqueue)
    }
  }

  function scanStore(enqueue) {
    const store = runtime.store || getStore()
    if (!store?.state) return
    scanConversation(store.state.currentUserInfo, enqueue)
    for (const name of ['chatList', 'todayChatList', 'searchChatList']) {
      const list = store.state[name]
      if (!Array.isArray(list)) continue
      for (const row of list) scanConversation(row, enqueue)
    }
  }

  function subscribeStore(store) {
    if (!store || store.__yzPddSubscribed || typeof store.subscribe !== 'function') return false
    store.subscribe((mutation) => {
      const type = String(mutation?.type || '')
      if (type) runtime.mutationTypes.add(type)
      visit(mutation?.payload, '', Date.now() >= runtime.warmupUntil, 0, new WeakSet())
    })
    store.__yzPddSubscribed = true
    return true
  }

  function wrapIm(im) {
    const options = im?.options
    if (!options || options.__yzPddOnmsgWrapped) return false
    try {
      let current = options.onmsg
      Object.defineProperty(options, 'onmsg', {
        configurable: true,
        enumerable: true,
        get() {
          return current
        },
        set(next) {
          if (typeof next !== 'function' || next.__yzPddWrapped) {
            current = next
            return
          }
          const wrapped = function (...args) {
            const enqueue = Date.now() >= runtime.warmupUntil
            for (const arg of args) visit(arg, '', enqueue, 0, new WeakSet())
            return next.apply(this, args)
          }
          wrapped.__yzPddWrapped = true
          current = wrapped
        }
      })
      if (typeof current === 'function') options.onmsg = current
      options.__yzPddOnmsgWrapped = true
      return true
    } catch {
      return false
    }
  }

  function attach() {
    const store = getStore()
    if (!store?.state) return false
    runtime.store = store
    runtime.im = store.state.IMSDK || null
    if (!runtime.seeded) {
      scanStore(false)
      runtime.seeded = true
    }
    subscribeStore(store)
    wrapIm(runtime.im)
    runtime.attached = true
    return true
  }

  const api = {
    version: VERSION,
    rescan() {
      attach()
      scanStore(Date.now() >= runtime.warmupUntil)
      return api.status()
    },
    drain() {
      const batch = runtime.queue.splice(0, runtime.queue.length)
      return batch
    },
    pending() {
      return runtime.queue.slice()
    },
    status() {
      const store = getStore()
      const im = store?.state?.IMSDK
      const root = document.querySelector('#app')
      return {
        version: VERSION,
        attached: runtime.attached,
        storeReady: Boolean(store),
        imReady: Boolean(im),
        sendCmdMsgReady: typeof im?.sendCmdMsg === 'function',
        historyReady: typeof im?.getHistoryMessage === 'function',
        queueSize: runtime.queue.length,
        seenCount: runtime.seen.size,
        mutationTypes: Array.from(runtime.mutationTypes).slice(-50),
        installedAt: runtime.installedAt,
        warmupUntil: runtime.warmupUntil,
        lastMessageAt: runtime.lastMessageAt,
        page: {
          path: location.pathname,
          title: document.title,
          readyState: document.readyState,
          rootExists: Boolean(root),
          rootKeys: root
            ? Object.getOwnPropertyNames(root)
                .filter((key) => key.toLowerCase().includes('vue'))
                .slice(0, 20)
            : [],
          appRootCount: document.querySelectorAll('[data-v-app]').length,
          frameCount: window.frames.length
        }
      }
    }
  }

  window.__YZ_PDD_HOOK_V1__ = api
  attach()
  setInterval(() => {
    attach()
    scanStore(Date.now() >= runtime.warmupUntil)
  }, 400)
})()
