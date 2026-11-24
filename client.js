window.__ModuleLoader__.load({
  id: 'dsh-approval-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Profile entry id of this plugin, the settings namespace. */
    const NS = 'approval-notify'

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px', maxWidth: '760px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      label: { fontSize: '12px', letterSpacing: '0.02em', color: 'var(--dsw-alias-label-secondary)' },
      status: { fontSize: '14px', lineHeight: 1.55, color: 'var(--dsw-alias-label-primary)' },
      detail: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
      switchRow: {
        display: 'flex',
        gap: '12px',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        padding: '8px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      switchText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto' },
      name: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', lineHeight: 1.45, color: 'var(--dsw-alias-label-secondary)' },
      pill: {
        minWidth: '52px',
        padding: '5px 12px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: '12px',
      },
      pillOff: {
        minWidth: '52px',
        padding: '5px 12px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: '12px',
      },
      button: {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: '13px',
      },
      busy: { opacity: 0.55, cursor: 'default' },
      error: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
      pre: {
        margin: 0,
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: '11px',
        lineHeight: 1.45,
        overflowX: 'auto',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /** Switch definitions rendered in order. */
    const SWITCHES = [
      {
        key: 'enabled',
        name: '总开关',
        hint: '关掉后审批、提问、完成、出错都不再提醒。',
      },
      {
        key: 'approvals',
        name: '审批提醒',
        hint: '工具调用需要你授权时提醒。只在权限模式的审批为「询问」（只读 / 工作区写入）时才会发生；「完全访问」会直接拒绝，不会有审批请求。',
      },
      {
        key: 'questions',
        name: '提问提醒',
        hint: 'Agent 用 ask_user_question 停下来问你时提醒。',
      },
      {
        key: 'finishes',
        name: '回合完成提醒',
        hint: '一个会话跑完、开始等你时提醒。这是最容易触发的一类。',
      },
      {
        key: 'errors',
        name: '出错提醒',
        hint: '会话出错、回合异常结束时提醒。',
      },
      {
        key: 'sound',
        name: '提示音',
        hint: '提示音随横幅交给系统播放：审批 Glass、提问 Ping、完成 Tink、出错 Basso。',
      },
      {
        key: 'skipWhenFocused',
        name: 'DSH 在前台时不发完成提醒',
        hint: '你正看着 DSH 时，「完成」提醒会被跳过；审批与提问不受影响。',
      },
      {
        key: 'clickable',
        name: '点击横幅切回 DSH',
        hint: '横幅由自带的 DSH Notify 小应用发送，点击即把 DSH 切到前台；首次会请求一次通知权限，被拒绝时自动退回兼容通道。关掉后同样走 osascript 兼容通道：无需授权，但横幅显示为「脚本编辑器」且不能点击。',
      },
    ]

    /**
     * Read this plugin's settings namespace through the client settings channel.
     * @param {() => object | undefined} remote - resolves `ctx.remote` lazily.
     * @param {(view: object) => void} onView - receives the namespace view.
     * @param {(message: string) => void} onError - receives a readable failure.
     */
    function createLoader(remote, onView, onError) {
      return async () => {
        let settings
        try {
          settings = remote()?.settings
        } catch (error) {
          onError(`读取设置通道失败：${error?.message ?? error}`)
          return
        }
        if (settings === undefined || typeof settings.describe !== 'function') {
          onError('客户端拿不到 ctx.remote.settings，页面无法读取状态；请把这条信息反馈给插件作者。')
          return
        }
        try {
          const described = await settings.describe()
          const view = (described?.namespaces ?? []).find(entry => entry?.ns === NS)
          if (view === undefined) {
            onError(`设置里没有 ${NS} 命名空间。`)
            return
          }
          onView(view)
        } catch (error) {
          onError(`读取状态失败：${error?.message ?? error}`)
        }
      }
    }

    /**
     * One labelled switch row.
     * @param {{ name: string, hint: string, value: boolean, disabled: boolean, onToggle: () => void }} props - row props.
     */
    function Switch({ name, hint, value, disabled, onToggle }) {
      const style = value ? styles.pill : styles.pillOff
      return h('div', { style: styles.switchRow },
        h('div', { style: styles.switchText },
          h('div', { style: styles.name }, name),
          h('div', { style: styles.hint }, hint),
        ),
        h('button', {
          style: disabled ? { ...style, ...styles.busy } : style,
          disabled,
          onClick: onToggle,
        }, value ? '开' : '关'),
      )
    }

    /**
     * Notification settings page inside Settings → Plugins.
     * @param {object} props - slot props plus the lazy remote resolver.
     */
    function PageView({ remote }) {
      const [view, setView] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(
        createLoader(remote, next => { setView(next); setError(null) }, message => setError(message)),
        [remote],
      )

      useEffect(() => {
        void load()
      }, [load])

      const write = async patch => {
        let settings
        try {
          settings = remote()?.settings
        } catch (caught) {
          setError(String(caught?.message ?? caught))
          return
        }
        if (settings === undefined || typeof settings.update !== 'function') {
          setError('客户端拿不到 ctx.remote.settings，无法执行操作。')
          return
        }
        setBusy(true)
        try {
          await settings.update(NS, patch)
          await new Promise(resolve => setTimeout(resolve, 1400))
          await load()
        } catch (caught) {
          setError(`操作失败：${caught?.message ?? caught}`)
        } finally {
          setBusy(false)
        }
      }

      const values = view?.value ?? {}
      const status = typeof values.status === 'string' ? values.status : ''
      const details = typeof values.details === 'string' ? values.details : ''
      const enabled = values.enabled !== false

      return h('div', { style: styles.wrap },
        h('div', { style: styles.card },
          h('div', { style: styles.label }, '状态'),
          h('div', { style: styles.status }, status === '' ? '（暂无状态，点「刷新」重试）' : status),
          details === '' ? null : h('div', { style: styles.detail }, details),
        ),
        h('div', { style: styles.card },
          h('div', { style: styles.label }, '提醒哪些时刻'),
          ...SWITCHES.map(entry => h(Switch, {
            key: entry.key,
            name: entry.name,
            hint: entry.hint,
            value: values[entry.key] !== false,
            disabled: busy,
            onToggle: () => void write({ [entry.key]: values[entry.key] === false }),
          })),
        ),
        h('div', { style: styles.row },
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void write({ testNow: true }),
          }, '发送测试通知'),
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void write({ diagnoseNow: true }),
          }, '自检'),
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void write({ openSettingsNow: true }),
          }, '打开系统通知设置'),
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void load(),
          }, '刷新'),
        ),
        h('div', { style: styles.hint },
          '点击切回开启时，横幅在系统里显示为「DSH Notify」，第一次会请求通知授权；'
          + '关闭时显示为「脚本编辑器 / Script Editor」，不能点击。'
          + '收不到时先看系统设置 → 通知里对应的应用是否被静音，再看是否开着专注模式。'),
        enabled ? null : h('div', { style: styles.hint }, '总开关关着：下面的事件开关保存了也不会发通知。'),
        error === null ? null : h('div', { style: styles.error }, error),
        view === null ? null : h('details', {},
          h('summary', { style: styles.hint }, '命名空间原始值'),
          h('pre', { style: styles.pre }, JSON.stringify(values, undefined, 2)),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const remote = () => {
          if (ctx.remote !== undefined) return ctx.remote
          if (typeof ctx.get === 'function') return ctx.get('remote')
          return undefined
        }
        const Page = () => h(PageView, { remote })
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'approval-notify',
          order: 56,
          label: '审批提醒',
        }, Page))
      },
    }
  },
})