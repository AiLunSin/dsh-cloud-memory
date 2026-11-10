window.__ModuleLoader__.load({
  id: 'dsh-cloud-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dshMemory'
    const API = '/dsh-memory/api'

    const DICT = {
      en: {
        navLabel: 'Memory',
        pageTitle: 'Cloud memory',
        pageSubtitle: 'Persistent facts, preferences, and decisions recalled across sessions with semantic + keyword retrieval.',
        tabMemories: 'Memories',
        tabCache: 'Cache & health',
        refresh: 'Refresh',
        loading: 'Loading…',
        searchPlaceholder: 'Ask your memory, e.g. “Which framework did I use for the service?”',
        search: 'Search',
        clear: 'Clear',
        scope: 'Scope',
        scopeUser: 'All conversations',
        scopeGlobal: 'Shared memory',
        scopeSession: 'This conversation',
        sessionId: 'Conversation id',
        topk: 'Results',
        resultsTitle: 'Search results',
        resultsEmpty: 'No matching memories yet.',
        noResults: 'Nothing matched. Try different words or save a new memory.',
        allMemories: 'Saved memories',
        loadMore: 'Load more',
        emptyList: 'No memories saved yet. Save the first durable fact below.',
        saveMemory: 'Save a memory',
        saveMemoryHint: 'Write one self-contained fact. Phone numbers, emails, IDs, and API keys are masked before storage.',
        contentPlaceholder: 'e.g. The user prefers Python 3.11 and FastAPI, deployed on Kubernetes.',
        keywordsPlaceholder: 'Optional keywords, comma separated',
        save: 'Save',
        saving: 'Saving…',
        edit: 'Edit',
        delete: 'Delete',
        confirmDelete: 'Delete this memory?',
        cancel: 'Cancel',
        update: 'Update',
        keywordLabel: 'Keywords',
        created: 'Saved',
        source: 'Source',
        session: 'Conversation',
        version: 'Version',
        activeMemories: 'Active memories',
        pendingEmbedding: 'Pending embeddings',
        cacheHitRate: 'Cache hit rate',
        cacheEntries: 'Cache entries',
        missP95: 'Miss p95',
        cacheTitle: 'Three-tier cache',
        cacheSubtitle: 'L1 process memory → L2 local file → L3 Redis. Search keys include the per-user index version, so a write makes older cached results physically unreachable.',
        hitRate: 'Hit rate',
        entries: 'Entries',
        latency: 'Latency p95',
        embeddings: 'Embedding calls',
        evictions: 'Evictions',
        l3: 'L3 Redis',
        provider: 'Embedding provider',
        on: 'On',
        off: 'Off',
        connected: 'Connected',
        notConnected: 'Not connected',
        purgeCache: 'Purge search cache',
        reembed: 'Retry pending vectors',
        purgeHint: 'Purging bumps the index version and clears cached search responses. Embedding cache is kept.',
        cacheHit: 'cache hit',
        cacheMiss: 'cache miss',
        semantic: 'semantic',
        keyword: 'keyword',
        both: 'both channels',
        score: 'Fused score',
        requestFailed: 'Request failed',
        saved: 'Memory saved.',
        updated: 'Memory updated.',
        deleted: 'Memory deleted.',
        purged: 'Search cache purged.',
        reembedded: 'Vector retry finished.',
        noKeywords: 'no keywords',
        modeLocal: 'Local hash fallback',
        modeRemote: 'BGE-M3 endpoint',
        localHint: 'No embedding endpoint is configured, so the semantic channel uses a deterministic lexical hash. Configure embedding.baseUrl for BGE-M3.',
        health: 'Health',
        storage: 'Storage',
        indexVersion: 'Index version',
        uptime: 'Uptime',
        totalMemories: 'Total memories',
        justNow: 'just now',
        minutesAgo: 'm ago',
        hoursAgo: 'h ago',
        daysAgo: 'd ago',
      },
      zh: {
        navLabel: '记忆',
        pageTitle: '云端记忆',
        pageSubtitle: '跨会话保存事实、偏好与决策，通过语义 + 关键字双通道召回。',
        tabMemories: '记忆',
        tabCache: '缓存与状态',
        refresh: '刷新',
        loading: '加载中…',
        searchPlaceholder: '搜索记忆，例如“我之前用什么框架写服务？”',
        search: '搜索',
        clear: '清除',
        scope: '范围',
        scopeUser: '全部会话',
        scopeGlobal: '共享记忆',
        scopeSession: '当前会话',
        sessionId: '会话 ID',
        topk: '结果数',
        resultsTitle: '搜索结果',
        resultsEmpty: '暂时没有匹配的记忆。',
        noResults: '没有匹配结果。换个说法，或先保存一条新记忆。',
        allMemories: '已保存记忆',
        loadMore: '加载更多',
        emptyList: '还没有记忆。在下方保存第一条长期事实。',
        saveMemory: '保存记忆',
        saveMemoryHint: '写一条自包含的事实。手机号、邮箱、证件号与 API Key 会在落库前脱敏。',
        contentPlaceholder: '例如：用户偏好 Python 3.11 + FastAPI，部署在 Kubernetes。',
        keywordsPlaceholder: '可选关键字，逗号分隔',
        save: '保存',
        saving: '保存中…',
        edit: '编辑',
        delete: '删除',
        confirmDelete: '确定删除这条记忆？',
        cancel: '取消',
        update: '更新',
        keywordLabel: '关键字',
        created: '保存于',
        source: '来源',
        session: '会话',
        version: '版本',
        activeMemories: '有效记忆',
        pendingEmbedding: '待向量化',
        cacheHitRate: '缓存命中率',
        cacheEntries: '缓存条目',
        missP95: '未命中 p95',
        cacheTitle: '三层缓存',
        cacheSubtitle: 'L1 进程内存 → L2 本地文件 → L3 Redis。检索键包含用户级索引版本，写入后旧缓存物理上不可达。',
        hitRate: '命中率',
        entries: '条目',
        latency: '延迟 p95',
        embeddings: '向量化调用',
        evictions: '淘汰',
        l3: 'L3 Redis',
        provider: 'Embedding 服务',
        on: '已启用',
        off: '未启用',
        connected: '已连接',
        notConnected: '未连接',
        purgeCache: '清空检索缓存',
        reembed: '重试待向量化',
        purgeHint: '清空会递增索引版本并删除检索缓存；向量缓存保留。',
        cacheHit: '缓存命中',
        cacheMiss: '未命中',
        semantic: '语义',
        keyword: '关键字',
        both: '双通道',
        score: '融合分',
        requestFailed: '请求失败',
        saved: '记忆已保存。',
        updated: '记忆已更新。',
        deleted: '记忆已删除。',
        purged: '检索缓存已清空。',
        reembedded: '向量重试完成。',
        noKeywords: '无关键字',
        modeLocal: '本地哈希兜底',
        modeRemote: 'BGE-M3 服务',
        localHint: '未配置向量服务，语义通道使用确定性词法哈希。配置 embedding.baseUrl 可接入 BGE-M3。',
        health: '运行状态',
        storage: '存储',
        indexVersion: '索引版本',
        uptime: '运行时长',
        totalMemories: '记忆总数',
        justNow: '刚刚',
        minutesAgo: ' 分钟前',
        hoursAgo: ' 小时前',
        daysAgo: ' 天前',
      },
    }

    function Icon({ name, size = 16 }) {
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', flex: 'none' },
      }
      switch (name) {
        case 'search':
          return h('svg', common, h('circle', { cx: 11, cy: 11, r: 7 }), h('path', { d: 'm20 20-3.5-3.5' }))
        case 'refresh':
          return h('svg', common, h('path', { d: 'M20 11a8 8 0 1 0-2.3 6.7' }), h('path', { d: 'M20 4v7h-7' }))
        case 'plus':
          return h('svg', common, h('path', { d: 'M12 5v14M5 12h14' }))
        case 'trash':
          return h('svg', common, h('path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6' }))
        case 'edit':
          return h('svg', common, h('path', { d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z' }), h('path', { d: 'm13.5 6.5 3 3' }))
        case 'cloud':
          return h('svg', common, h('path', { d: 'M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.8 8.6 4.2 4.2 0 0 1 17 18H7Z' }))
        case 'database':
          return h('svg', common, h('ellipse', { cx: 12, cy: 5.5, rx: 7, ry: 3 }), h('path', { d: 'M5 5.5v13c0 1.7 3.1 3 7 3s7-1.3 7-3v-13' }), h('path', { d: 'M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3' }))
        case 'layers':
          return h('svg', common, h('path', { d: 'm12 3 9 5-9 5-9-5 9-5Z' }), h('path', { d: 'm3 13 9 5 9-5' }), h('path', { d: 'm3 17 9 5 9-5' }))
        case 'clock':
          return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8 }), h('path', { d: 'M12 8v4l3 2' }))
        case 'spark':
          return h('svg', common, h('path', { d: 'm12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z' }), h('path', { d: 'm18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z' }))
        case 'check':
          return h('svg', common, h('path', { d: 'm4 12 5 5L20 6' }))
        case 'x':
          return h('svg', common, h('path', { d: 'm6 6 12 12M18 6 6 18' }))
        default:
          return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8 }))
      }
    }

    function NavIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      const color = props?.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { d: 'M6.5 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 16.9 8.7 3.8 3.8 0 0 1 17 18H6.5Z' }),
        h('circle', { cx: 9.2, cy: 13.2, r: 1.15, fill: color, stroke: 'none' }),
        h('circle', { cx: 12.6, cy: 11.2, r: 1.15, fill: color, stroke: 'none' }),
        h('circle', { cx: 12.6, cy: 15.1, r: 1.15, fill: color, stroke: 'none' }),
        h('path', { d: 'M10.3 12.8l1.2-.9M13.6 12.2v1.7' }),
      )
    }

    async function request(path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {}
      if (!response.ok || !payload || payload.code !== 0) {
        const message = payload?.message || `HTTP ${response.status}`
        const error = new Error(message)
        error.code = payload?.code
        error.status = response.status
        throw error
      }
      return payload.data
    }

    function relativeTime(value, t) {
      const time = Date.parse(value)
      if (!Number.isFinite(time)) return ''
      const delta = Math.max(0, Date.now() - time)
      const minute = 60000
      const hour = 3600000
      const day = 86400000
      if (delta < minute) return t('justNow')
      if (delta < hour) return `${Math.floor(delta / minute)}${t('minutesAgo')}`
      if (delta < day) return `${Math.floor(delta / hour)}${t('hoursAgo')}`
      return `${Math.floor(delta / day)}${t('daysAgo')}`
    }

    function pct(value) {
      return `${Math.round((Number(value) || 0) * 100)}%`
    }

    function splitKeywords(value) {
      return String(value || '')
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20)
    }

    function MemoryPage() {
      const [tick, setTick] = useState(0)
      const t = useCallback((key) => translate(key), [tick])
      const [tab, setTab] = useState('memories')
      const [stats, setStats] = useState(null)
      const [list, setList] = useState({ items: [], next_cursor: null, total: 0 })
      const [query, setQuery] = useState('')
      const [scope, setScope] = useState('user')
      const [sessionId, setSessionId] = useState('')
      const [topk, setTopk] = useState(10)
      const [results, setResults] = useState(null)
      const [draft, setDraft] = useState('')
      const [draftKeywords, setDraftKeywords] = useState('')
      const [editing, setEditing] = useState(null)
      const [confirmDelete, setConfirmDelete] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [initialLoading, setInitialLoading] = useState(true)

      useEffect(() => {
        if (typeof ctxLocaleSubscribe === 'function') {
          return ctxLocaleSubscribe(() => setTick((value) => value + 1))
        }
        return undefined
      }, [])

      const showNotice = useCallback((message) => {
        setNotice(message)
        setTimeout(() => setNotice(''), 2600)
      }, [])

      const loadStats = useCallback(async () => {
        try {
          const data = await request('/stats')
          setStats(data)
        } catch {}
      }, [])

      const loadList = useCallback(async (cursor, append) => {
        setBusy((current) => current || 'list')
        try {
          const params = new URLSearchParams({ limit: '20' })
          if (cursor) params.set('cursor', cursor)
          const data = await request(`/memories?${params.toString()}`)
          setList((current) => append
            ? { ...data, items: [...current.items, ...data.items] }
            : data)
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy('')
        }
      }, [])

      const refresh = useCallback(async () => {
        await Promise.all([loadStats(), loadList(null, false)])
        setInitialLoading(false)
      }, [loadStats, loadList])

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          await refresh()
          if (cancelled) return
        })()
        const timer = setInterval(() => {
          loadStats()
        }, 20000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [refresh, loadStats])

      const runSearch = useCallback(async (event) => {
        if (event) event.preventDefault()
        const normalized = query.trim()
        if (!normalized) {
          setResults(null)
          return
        }
        setBusy('search')
        setError('')
        try {
          const data = await request('/search', {
            method: 'POST',
            body: JSON.stringify({
              query: normalized,
              scope,
              session_id: scope === 'session' ? sessionId.trim() : undefined,
              topk,
            }),
          })
          setResults(data)
          await loadStats()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy('')
        }
      }, [query, scope, sessionId, topk, loadStats])

      const saveMemory = useCallback(async () => {
        const content = draft.trim()
        if (!content) return
        setBusy('save')
        setError('')
        try {
          await request('/memories', {
            method: 'POST',
            body: JSON.stringify({
              content,
              keywords: splitKeywords(draftKeywords),
              source: 'ui',
              session_id: sessionId.trim() || 'ui',
            }),
          })
          setDraft('')
          setDraftKeywords('')
          showNotice(t('saved'))
          setResults(null)
          await refresh()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy('')
        }
      }, [draft, draftKeywords, sessionId, refresh, showNotice, t])

      const startEdit = useCallback((item) => {
        setConfirmDelete(null)
        setEditing({ id: item.id, content: item.content, keywords: (item.keywords || []).join(', '), version: item.version })
      }, [])

      const saveEdit = useCallback(async () => {
        if (!editing) return
        setBusy('edit')
        setError('')
        try {
          await request(`/memories/${encodeURIComponent(editing.id)}`, {
            method: 'PUT',
            body: JSON.stringify({
              content: editing.content,
              keywords: splitKeywords(editing.keywords),
              version: editing.version,
            }),
          })
          setEditing(null)
          showNotice(t('updated'))
          setResults(null)
          await refresh()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy('')
        }
      }, [editing, refresh, showNotice, t])

      const removeMemory = useCallback(async (id) => {
        setBusy('delete')
        setError('')
        try {
          await request(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
          setConfirmDelete(null)
          setEditing(null)
          showNotice(t('deleted'))
          setResults(null)
          await refresh()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy('')
        }
      }, [refresh, showNotice, t])

      const purgeCache = useCallback(async () => {
        setBusy('purge')
        setError('')
        try {
          await request('/cache/purge', { method: 'POST', body: JSON.stringify({ level: 'all', scope: 'all' }) })
          showNotice(t('purged'))
          await loadStats()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy('')
        }
      }, [loadStats, showNotice, t])

      const reembed = useCallback(async () => {
        setBusy('reembed')
        setError('')
        try {
          await request('/memories:reembed', { method: 'POST', body: JSON.stringify({}) })
          showNotice(t('reembedded'))
          await refresh()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy('')
        }
      }, [refresh, showNotice, t])

      const cache = stats?.cache
      const embedding = stats?.embedding
      const isLocal = embedding?.mode === 'local'
      const providerLabel = isLocal ? t('modeLocal') : t('modeRemote')
      const l3 = cache?.l3
      const activeCount = stats?.memories?.active ?? list.total ?? 0
      const pendingCount = stats?.memories?.pending ?? 0
      const hitRate = cache?.hit_rate?.overall ?? 0
      const entries = (cache?.entries?.l1 ?? 0) + (cache?.entries?.l2 ?? 0) + (cache?.entries?.l3 ?? 0)
      const missP95 = cache?.latency_ms?.cache_miss_p95 ?? 0

      const memoryRow = (item, fromSearch) => {
        const isEditing = editing?.id === item.id
        const chips = item.keywords ?? []
        return h('article', { className: 'dshm-card dshm-memory', key: item.id },
          isEditing
            ? h('div', { className: 'dshm-edit' },
                h('textarea', {
                  className: 'dshm-textarea',
                  value: editing.content,
                  rows: 4,
                  onChange: (event) => setEditing({ ...editing, content: event.target.value }),
                }),
                h('input', {
                  className: 'dshm-input',
                  value: editing.keywords,
                  placeholder: t('keywordsPlaceholder'),
                  onChange: (event) => setEditing({ ...editing, keywords: event.target.value }),
                }),
                h('div', { className: 'dshm-row-actions' },
                  h('button', { className: 'dshm-btn dshm-btn-primary', disabled: busy === 'edit', onClick: saveEdit }, busy === 'edit' ? t('saving') : t('update')),
                  h('button', { className: 'dshm-btn', onClick: () => setEditing(null) }, t('cancel')),
                ),
              )
            : h(React.Fragment, null,
                h('div', { className: 'dshm-memory-content' }, item.content),
                h('div', { className: 'dshm-memory-meta' },
                  h('span', null, `${t('session')}: ${item.session_id || '—'}`),
                  h('span', null, `${t('source')}: ${item.source || '—'}`),
                  h('span', null, `${t('version')}: ${item.version}`),
                  h('span', null, `${t('created')}: ${relativeTime(item.created_at, t)}`),
                  fromSearch && item.scores
                    ? h('span', { className: 'dshm-score' }, `${t('semantic')} ${item.scores.semantic ?? '—'} · ${t('keyword')} ${item.scores.keyword ?? '—'}`)
                    : null,
                ),
                chips.length
                  ? h('div', { className: 'dshm-chips' }, chips.map((keyword) => h('span', { className: 'dshm-chip', key: keyword }, keyword)))
                  : h('div', { className: 'dshm-muted' }, t('noKeywords')),
                fromSearch
                  ? h('div', { className: 'dshm-row-actions' },
                      h('span', { className: 'dshm-pill' }, item.sources?.includes('both') ? t('both') : item.sources?.includes('vector') ? t('semantic') : t('keyword')),
                      h('span', { className: 'dshm-muted dshm-score' }, `${t('score')} ${item.score}`),
                    )
                  : confirmDelete === item.id
                    ? h('div', { className: 'dshm-row-actions' },
                        h('span', { className: 'dshm-danger-text' }, t('confirmDelete')),
                        h('button', { className: 'dshm-btn dshm-btn-danger', disabled: busy === 'delete', onClick: () => removeMemory(item.id) }, t('delete')),
                        h('button', { className: 'dshm-btn', onClick: () => setConfirmDelete(null) }, t('cancel')),
                      )
                    : h('div', { className: 'dshm-row-actions' },
                        h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: () => startEdit(item) }, h(Icon, { name: 'edit', size: 14 }), t('edit')),
                        h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: () => { setConfirmDelete(item.id); setEditing(null) } }, h(Icon, { name: 'trash', size: 14 }), t('delete')),
                      ),
              ),
        )
      }

      const statCard = (label, value, hint, icon) => h('div', { className: 'dshm-stat' },
        h('div', { className: 'dshm-stat-top' }, h(Icon, { name: icon, size: 15 }), h('span', null, label)),
        h('strong', null, value),
        hint ? h('span', { className: 'dshm-muted' }, hint) : null,
      )

      const cacheCard = (label, value, hint) => h('div', { className: 'dshm-card dshm-cache-card' },
        h('span', { className: 'dshm-muted' }, label),
        h('strong', null, value),
        hint ? h('span', { className: 'dshm-muted dshm-small' }, hint) : null,
      )

      return h('div', { className: 'dshm-root' },
        h('style', null, CSS),
        h('header', { className: 'dshm-header' },
          h('div', { className: 'dshm-header-main' },
            h('div', { className: 'dshm-title-wrap' },
              h('div', { className: 'dshm-logo' }, h(Icon, { name: 'cloud', size: 20 })),
              h('div', null,
                h('h1', { className: 'dshm-title' }, t('pageTitle')),
                h('p', { className: 'dshm-subtitle' }, t('pageSubtitle')),
              ),
            ),
            h('div', { className: 'dshm-header-actions' },
              h('span', { className: `dshm-pill ${isLocal ? 'dshm-pill-warn' : 'dshm-pill-ok'}` }, `${providerLabel} · ${embedding?.state ?? '—'}`),
              h('span', { className: 'dshm-pill' }, `L3 ${l3?.enabled ? (l3.connected ? t('connected') : t('notConnected')) : t('off')}`),
              h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: refresh, disabled: busy === 'list' }, h(Icon, { name: 'refresh', size: 14 }), t('refresh')),
            ),
          ),
          h('nav', { className: 'dshm-tabs' },
            h('button', { className: `dshm-tab ${tab === 'memories' ? 'dshm-tab-active' : ''}`, onClick: () => setTab('memories') }, t('tabMemories')),
            h('button', { className: `dshm-tab ${tab === 'cache' ? 'dshm-tab-active' : ''}`, onClick: () => setTab('cache') }, t('tabCache')),
          ),
        ),
        h('div', { className: 'dshm-scroll' },
          error ? h('div', { className: 'dshm-banner dshm-banner-error' },
            h(Icon, { name: 'x', size: 14 }),
            h('span', null, error),
            h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: () => setError('') }, t('clear')),
          ) : null,
          notice ? h('div', { className: 'dshm-banner dshm-banner-ok' }, h(Icon, { name: 'check', size: 14 }), h('span', null, notice)) : null,
          initialLoading
            ? h('div', { className: 'dshm-empty' }, t('loading'))
            : tab === 'memories'
              ? h('div', { className: 'dshm-inner' },
                  h('section', { className: 'dshm-stats' },
                    statCard(t('activeMemories'), String(activeCount), `${pendingCount} ${t('pendingEmbedding')}`, 'layers'),
                    statCard(t('cacheHitRate'), pct(hitRate), cache ? `L1 ${pct(cache.hit_rate.l1)} · L2 ${pct(cache.hit_rate.l2)} · L3 ${pct(cache.hit_rate.l3)}` : '', 'database'),
                    statCard(t('cacheEntries'), String(entries), `L1 ${cache?.entries?.l1 ?? 0} · L2 ${cache?.entries?.l2 ?? 0} · L3 ${cache?.entries?.l3 ?? 0}`, 'spark'),
                    statCard(t('missP95'), `${missP95} ms`, cache ? `hit ${cache.latency_ms.cache_hit_p95} ms` : '', 'clock'),
                  ),
                  h('form', { className: 'dshm-card dshm-search', onSubmit: runSearch },
                    h('div', { className: 'dshm-search-row' },
                      h('div', { className: 'dshm-search-input' },
                        h(Icon, { name: 'search', size: 16 }),
                        h('input', {
                          className: 'dshm-input dshm-input-plain',
                          value: query,
                          placeholder: t('searchPlaceholder'),
                          onChange: (event) => setQuery(event.target.value),
                        }),
                      ),
                      h('button', { className: 'dshm-btn dshm-btn-primary', type: 'submit', disabled: busy === 'search' }, t('search')),
                    ),
                    h('div', { className: 'dshm-search-options' },
                      h('label', { className: 'dshm-field' }, h('span', null, t('scope')),
                        h('select', { className: 'dshm-select', value: scope, onChange: (event) => setScope(event.target.value) },
                          h('option', { value: 'user' }, t('scopeUser')),
                          h('option', { value: 'global' }, t('scopeGlobal')),
                          h('option', { value: 'session' }, t('scopeSession')),
                        ),
                      ),
                      scope === 'session'
                        ? h('label', { className: 'dshm-field dshm-grow' }, h('span', null, t('sessionId')),
                            h('input', { className: 'dshm-input', value: sessionId, onChange: (event) => setSessionId(event.target.value) }),
                          )
                        : null,
                      h('label', { className: 'dshm-field' }, h('span', null, t('topk')),
                        h('select', { className: 'dshm-select', value: topk, onChange: (event) => setTopk(Number(event.target.value)) },
                          h('option', { value: 5 }, '5'),
                          h('option', { value: 10 }, '10'),
                          h('option', { value: 20 }, '20'),
                        ),
                      ),
                      query || results
                        ? h('button', { className: 'dshm-btn dshm-btn-ghost', type: 'button', onClick: () => { setQuery(''); setResults(null) } }, t('clear'))
                        : null,
                    ),
                  ),
                  results
                    ? h('section', { className: 'dshm-section' },
                        h('div', { className: 'dshm-section-head' },
                          h('h2', null, t('resultsTitle')),
                          h('span', { className: 'dshm-muted' }, `${results.total} · ${results.cache?.hit ? `${t('cacheHit')} ${results.cache.level}` : t('cacheMiss')} · ${results.latency_ms} ms`),
                        ),
                        results.degraded ? h('div', { className: 'dshm-banner dshm-banner-warn' }, `degraded: ${results.degraded_reason}`) : null,
                        results.results.length
                          ? h('div', { className: 'dshm-list' }, results.results.map((item) => memoryRow(item, true)))
                          : h('div', { className: 'dshm-empty' }, t('noResults')),
                      )
                    : null,
                  h('section', { className: 'dshm-section' },
                    h('div', { className: 'dshm-section-head' },
                      h('h2', null, t('allMemories')),
                      h('span', { className: 'dshm-muted' }, `${list.total}`),
                    ),
                    h('div', { className: 'dshm-card dshm-save' },
                      h('div', { className: 'dshm-section-head' },
                        h('h3', null, t('saveMemory')),
                        h('span', { className: 'dshm-muted dshm-small' }, t('saveMemoryHint')),
                      ),
                      h('textarea', {
                        className: 'dshm-textarea',
                        rows: 3,
                        value: draft,
                        placeholder: t('contentPlaceholder'),
                        onChange: (event) => setDraft(event.target.value),
                      }),
                      h('div', { className: 'dshm-save-row' },
                        h('input', {
                          className: 'dshm-input dshm-grow',
                          value: draftKeywords,
                          placeholder: t('keywordsPlaceholder'),
                          onChange: (event) => setDraftKeywords(event.target.value),
                        }),
                        h('button', { className: 'dshm-btn dshm-btn-primary', disabled: !draft.trim() || busy === 'save', onClick: saveMemory },
                          h(Icon, { name: 'plus', size: 14 }),
                          busy === 'save' ? t('saving') : t('save'),
                        ),
                      ),
                    ),
                    list.items.length
                      ? h('div', { className: 'dshm-list' }, list.items.map((item) => memoryRow(item, false)))
                      : h('div', { className: 'dshm-empty' }, t('emptyList')),
                    list.next_cursor
                      ? h('div', { className: 'dshm-load-more' },
                          h('button', { className: 'dshm-btn', disabled: busy === 'list', onClick: () => loadList(list.next_cursor, true) }, t('loadMore')),
                        )
                      : null,
                  ),
                )
              : h('div', { className: 'dshm-inner' },
                  h('section', { className: 'dshm-section' },
                    h('div', { className: 'dshm-section-head' },
                      h('h2', null, t('cacheTitle')),
                      h('span', { className: 'dshm-muted' }, cache?.window_ms ? `${Math.round(cache.window_ms / 1000)}s` : ''),
                    ),
                    h('p', { className: 'dshm-muted dshm-copy' }, t('cacheSubtitle')),
                    h('div', { className: 'dshm-grid' },
                      cacheCard(t('hitRate'), pct(hitRate), `L1 ${pct(cache?.hit_rate?.l1)} · L2 ${pct(cache?.hit_rate?.l2)} · L3 ${pct(cache?.hit_rate?.l3)}`),
                      cacheCard(t('entries'), String(entries), `L1 ${cache?.entries?.l1 ?? 0} · L2 ${cache?.entries?.l2 ?? 0} · L3 ${cache?.entries?.l3 ?? 0}`),
                      cacheCard(t('latency'), `${cache?.latency_ms?.cache_hit_p95 ?? 0} / ${cache?.latency_ms?.cache_miss_p95 ?? 0} ms`, 'hit / miss'),
                      cacheCard(t('embeddings'), `${cache?.embedding_calls?.total ?? 0}`, `cache ${cache?.embedding_calls?.cached ?? 0} · api ${cache?.embedding_calls?.api ?? 0} · local ${cache?.embedding_calls?.local ?? 0}`),
                      cacheCard(t('evictions'), `${cache?.evictions?.lru ?? 0} / ${cache?.evictions?.ttl ?? 0}`, 'LRU / TTL'),
                      cacheCard(t('l3'), l3?.enabled ? (l3.connected ? t('connected') : t('notConnected')) : t('off'), l3?.enabled ? `${l3.keys ?? 0} keys` : 'redis://'),
                    ),
                    h('div', { className: 'dshm-row-actions dshm-cache-actions' },
                      h('button', { className: 'dshm-btn dshm-btn-danger', disabled: busy === 'purge', onClick: purgeCache }, h(Icon, { name: 'trash', size: 14 }), t('purgeCache')),
                      h('button', { className: 'dshm-btn', disabled: busy === 'reembed', onClick: reembed }, h(Icon, { name: 'refresh', size: 14 }), t('reembed')),
                    ),
                    h('p', { className: 'dshm-muted dshm-small' }, t('purgeHint')),
                  ),
                  h('section', { className: 'dshm-section' },
                    h('div', { className: 'dshm-section-head' },
                      h('h2', null, t('health')),
                      h('span', { className: 'dshm-muted' }, `v${stats?.index_version ?? '—'}`),
                    ),
                    h('div', { className: 'dshm-card dshm-health' },
                      healthRow(t('storage'), `${stats?.memories?.active ?? 0} ${t('activeMemories')} · ${stats?.memories?.deleted ?? 0} deleted`),
                      healthRow(t('provider'), `${providerLabel} · ${embedding?.model ?? '—'} · ${embedding?.dim ?? '—'} dim · ${embedding?.state ?? '—'}`),
                      healthRow(t('l3'), l3?.enabled ? (l3.connected ? t('connected') : t('notConnected')) : t('off')),
                      healthRow(t('indexVersion'), String(stats?.index_version ?? '—')),
                      healthRow(t('uptime'), `${Math.floor((stats?.uptime_s ?? 0) / 60)} min`),
                      isLocal ? h('p', { className: 'dshm-muted dshm-small' }, t('localHint')) : null,
                    ),
                  ),
                ),
        ),
      )

      function healthRow(label, value) {
        return h('div', { className: 'dshm-health-row' },
          h('span', { className: 'dshm-muted' }, label),
          h('span', null, value),
        )
      }
    }

    const CSS = `
      .dshm-root {
        --dshm-radius: 10px;
        height: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 13px;
        line-height: 1.5;
        overflow: hidden;
      }
      .dshm-header {
        flex: none;
        padding: 18px 24px 0;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base);
      }
      .dshm-header-main {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        max-width: 1040px;
        margin: 0 auto;
      }
      .dshm-title-wrap { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
      .dshm-logo {
        width: 34px; height: 34px; flex: none;
        display: grid; place-items: center;
        border-radius: 9px;
        color: var(--dsw-alias-brand-primary);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
        border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent);
      }
      .dshm-title { margin: 0; font-size: 17px; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; }
      .dshm-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; max-width: 620px; }
      .dshm-header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dshm-tabs {
        display: flex; gap: 2px; max-width: 1040px; margin: 14px auto 0;
      }
      .dshm-tab {
        appearance: none; border: 0; background: transparent; cursor: pointer;
        color: var(--dsw-alias-label-secondary);
        padding: 8px 11px 10px;
        font: inherit; font-size: 12.5px;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }
      .dshm-tab:hover { color: var(--dsw-alias-label-primary); }
      .dshm-tab-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
      .dshm-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 24px 40px; }
      .dshm-inner { max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
      .dshm-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
      .dshm-stat {
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        border-radius: var(--dshm-radius);
        padding: 11px 12px;
        display: flex; flex-direction: column; gap: 2px;
        min-width: 0;
      }
      .dshm-stat-top { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dshm-stat strong { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
      .dshm-stat .dshm-muted { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dshm-card {
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        border-radius: var(--dshm-radius);
        padding: 13px;
      }
      .dshm-search { display: flex; flex-direction: column; gap: 10px; }
      .dshm-search-row { display: flex; gap: 8px; align-items: center; }
      .dshm-search-input {
        flex: 1; display: flex; align-items: center; gap: 8px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px; padding: 0 10px;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-secondary);
        min-width: 0;
      }
      .dshm-search-input:focus-within { border-color: var(--dsw-alias-brand-primary); }
      .dshm-search-options { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
      .dshm-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dshm-field .dshm-grow { width: 180px; }
      .dshm-grow { flex: 1; min-width: 0; }
      .dshm-input, .dshm-select, .dshm-textarea {
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        border-radius: 7px;
        padding: 7px 9px;
        font: inherit;
        font-size: 12.5px;
        outline: none;
        box-sizing: border-box;
      }
      .dshm-input:focus, .dshm-select:focus, .dshm-textarea:focus { border-color: var(--dsw-alias-brand-primary); }
      .dshm-input-plain { border: 0; background: transparent; padding: 9px 0; flex: 1; min-width: 0; }
      .dshm-input-plain:focus { border: 0; }
      .dshm-textarea { resize: vertical; min-height: 58px; width: 100%; }
      .dshm-btn {
        appearance: none;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        border-radius: 7px;
        padding: 6px 10px;
        font: inherit;
        font-size: 12px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        white-space: nowrap;
      }
      .dshm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
      .dshm-btn:disabled { opacity: 0.5; cursor: default; }
      .dshm-btn-primary {
        color: var(--dsw-alias-brand-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
      }
      .dshm-btn-danger {
        color: var(--dsw-alias-state-error-primary);
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
      }
      .dshm-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
      .dshm-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .dshm-pill {
        display: inline-flex; align-items: center; gap: 5px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        border-radius: 999px;
        padding: 3px 8px;
        font-size: 10.5px;
        color: var(--dsw-alias-label-secondary);
        white-space: nowrap;
      }
      .dshm-pill-ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); }
      .dshm-pill-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent); }
      .dshm-section { display: flex; flex-direction: column; gap: 10px; }
      .dshm-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .dshm-section-head h2 { margin: 0; font-size: 13.5px; font-weight: 600; }
      .dshm-section-head h3 { margin: 0; font-size: 12.5px; font-weight: 600; }
      .dshm-muted { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dshm-small { font-size: 11px; }
      .dshm-copy { margin: 0; max-width: 820px; }
      .dshm-list { display: flex; flex-direction: column; gap: 8px; }
      .dshm-memory { display: flex; flex-direction: column; gap: 7px; }
      .dshm-memory-content { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
      .dshm-memory-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .dshm-score { font-variant-numeric: tabular-nums; }
      .dshm-chips { display: flex; flex-wrap: wrap; gap: 5px; }
      .dshm-chip {
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
        border-radius: 999px;
        padding: 1px 7px;
        font-size: 10.5px;
        color: var(--dsw-alias-label-secondary);
      }
      .dshm-row-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .dshm-memory .dshm-row-actions { margin-top: 1px; }
      .dshm-danger-text { color: var(--dsw-alias-state-error-primary); font-size: 11.5px; }
      .dshm-edit { display: flex; flex-direction: column; gap: 8px; }
      .dshm-save { display: flex; flex-direction: column; gap: 9px; }
      .dshm-save-row { display: flex; gap: 8px; align-items: center; }
      .dshm-empty {
        border: 1px dashed var(--dsw-alias-border-l1);
        border-radius: var(--dshm-radius);
        padding: 26px 18px;
        text-align: center;
        color: var(--dsw-alias-label-secondary);
        font-size: 12.5px;
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 60%, transparent);
      }
      .dshm-load-more { display: flex; justify-content: center; padding: 2px 0 8px; }
      .dshm-banner {
        display: flex; align-items: center; gap: 8px;
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12px;
        margin-bottom: 12px;
      }
      .dshm-banner-error { color: var(--dsw-alias-state-error-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
      .dshm-banner-ok { color: var(--dsw-alias-state-success-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
      .dshm-banner-warn { color: var(--dsw-alias-state-warn-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
      .dshm-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .dshm-cache-card { display: flex; flex-direction: column; gap: 2px; }
      .dshm-cache-card strong { font-size: 17px; font-weight: 600; }
      .dshm-cache-actions { margin-top: 2px; }
      .dshm-health { display: flex; flex-direction: column; gap: 0; padding: 4px 13px; }
      .dshm-health-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
      .dshm-health-row:last-of-type { border-bottom: 0; }
      .dshm-health .dshm-small { margin: 4px 0 8px; }
      @media (max-width: 820px) {
        .dshm-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .dshm-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 560px) {
        .dshm-header, .dshm-scroll { padding-left: 14px; padding-right: 14px; }
        .dshm-stats, .dshm-grid { grid-template-columns: minmax(0, 1fr); }
        .dshm-search-row, .dshm-save-row { flex-wrap: wrap; }
      }
    `

    let translate = function fallbackTranslate(key) { return key }
    let ctxLocaleSubscribe = null

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT))
        translate = ctx.locale.bind(NS)
        ctxLocaleSubscribe = (listener) => ctx.locale.subscribe(listener)
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'memory',
          order: 20,
          label: () => translate('navLabel'),
        }, NavIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'memory',
        }, MemoryPage))
      },
    }
  },
})
