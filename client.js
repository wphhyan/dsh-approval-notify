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

    /** Client copy registered with the locale service (both baseline locales). */
    const UI = {
      zh: {
        tab: '审批提醒',
        labelStatus: '状态',
        labelMoments: '提醒哪些时刻',
        statusEmpty: '（暂无状态，点「刷新」重试）',
        rawSummary: '命名空间原始值',
        pillOn: '开',
        pillOff: '关',
        buttonAuthorize: '请求通知授权',
        buttonTest: '发送测试通知',
        buttonDiagnose: '自检',
        buttonSettings: '打开系统通知设置',
        buttonRefresh: '刷新',
        hintBanner: '点击切回开启时，横幅在系统里显示为「DSH Notify」；授权只在点「请求通知授权」时请求，通知不会再自己弹授权框。关闭或未授权时显示为「脚本编辑器 / Script Editor」，不能点击。收不到时先看系统设置 → 通知里对应的应用是否被静音，再看是否开着专注模式。',
        hintMasterOff: '总开关关着：下面的事件开关保存了也不会发通知。',
        errorChannel: '读取设置通道失败：{reason}',
        errorNoRemote: '客户端拿不到 ctx.remote.settings，页面无法读取状态；请把这条信息反馈给插件作者。',
        errorNoNamespace: '设置里没有 {ns} 命名空间。',
        errorRead: '读取状态失败：{reason}',
        errorWrite: '操作失败：{reason}',
        switchEnabledName: '总开关',
        switchEnabledHint: '关掉后审批、提问、完成、出错都不再提醒。',
        switchApprovalsName: '审批提醒',
        switchApprovalsHint: '工具调用需要你授权时提醒。只在权限模式的审批为「询问」（只读 / 工作区写入）时才会发生；「完全访问」会直接拒绝，不会有审批请求。',
        switchQuestionsName: '提问提醒',
        switchQuestionsHint: 'Agent 用 ask_user_question 停下来问你时提醒。',
        switchFinishesName: '回合完成提醒',
        switchFinishesHint: '一个会话跑完、开始等你时提醒。这是最容易触发的一类。',
        switchErrorsName: '出错提醒',
        switchErrorsHint: '会话出错、回合异常结束时提醒。',
        switchSoundName: '提示音',
        switchSoundHint: '提示音随横幅交给系统播放：审批 Glass、提问 Ping、完成 Tink、出错 Basso。',
        switchFocusedName: 'DSH 在前台时不发完成提醒',
        switchFocusedHint: '你正看着 DSH 时，「完成」提醒会被跳过；审批与提问不受影响。',
        switchIdleName: '只在离开键盘时提醒',
        switchIdleHint: '改用系统空闲时间：空闲满 60 秒才发「完成」提醒。浏览器打开 GUI 时比「DSH 在前台」更准确，开启后替代上面的前台跳过。',
        switchClickableName: '点击横幅切回 DSH',
        switchClickableHint: '横幅由自带的 DSH Notify 小应用发送，点击即把 DSH 切到前台。需要一次通知授权：点页面下方的「请求通知授权」显式发起，通知本身永远不会弹授权框；没授权时自动走兼容通道。',
        switchScheduledName: '定时任务也提醒',
        switchScheduledHint: '默认关：定时任务（@michengai/dsh-automation）产生的会话不发完成 / 出错提醒，避免每分钟跑一次的坏任务刷屏。',
      },
      en: {
        tab: 'Approval notifications',
        labelStatus: 'Status',
        labelMoments: 'Which moments to announce',
        statusEmpty: '(no status yet — press Refresh)',
        rawSummary: 'Raw namespace values',
        pillOn: 'On',
        pillOff: 'Off',
        buttonAuthorize: 'Request notification permission',
        buttonTest: 'Send test notification',
        buttonDiagnose: 'Self-check',
        buttonSettings: 'Open system notification settings',
        buttonRefresh: 'Refresh',
        hintBanner: 'With click-to-focus on, the banner is shown as "DSH Notify"; permission is requested only by Request notification permission, and a notification never opens an authorization dialog by itself. Off — or unauthorized — falls back to Script Editor, which cannot be clicked. If nothing appears, check the matching app in System Settings → Notifications and any Focus mode.',
        hintMasterOff: 'The master switch is off: event switches save, but nothing is sent.',
        errorChannel: 'Settings channel failed: {reason}',
        errorNoRemote: 'ctx.remote.settings is unavailable, so the page cannot read the status; please report this to the plugin author.',
        errorNoNamespace: 'The settings namespace {ns} is missing.',
        errorRead: 'Reading the status failed: {reason}',
        errorWrite: 'The operation failed: {reason}',
        switchEnabledName: 'Master switch',
        switchEnabledHint: 'Turning it off silences approval, question, finish and error reminders.',
        switchApprovalsName: 'Approval reminders',
        switchApprovalsHint: 'Raised when a tool call needs your permission. Only exists while the permission preset asks (read-only or workspace-write); full access rejects those calls outright.',
        switchQuestionsName: 'Question reminders',
        switchQuestionsHint: 'Raised when the agent stops on ask_user_question.',
        switchFinishesName: 'Turn finished',
        switchFinishesHint: 'Raised when a session stops and waits for you; the most frequent kind.',
        switchErrorsName: 'Session errors',
        switchErrorsHint: 'Raised when a session or turn fails.',
        switchSoundName: 'Alert tone',
        switchSoundHint: 'The system plays the tone with the banner: approval Glass, question Ping, finish Tink, error Basso.',
        switchFocusedName: 'Skip finish reminders while DSH is frontmost',
        switchFocusedHint: 'Finish reminders are skipped while you are looking at DSH; approvals and questions are unaffected.',
        switchIdleName: 'Only remind me when I am away',
        switchIdleHint: 'Uses the system idle time: finish reminders need 60s of keyboard/mouse inactivity. More accurate than the frontmost check when the GUI runs in a browser; this replaces the check above.',
        switchClickableName: 'Click a banner to return to DSH',
        switchClickableHint: 'The bundled DSH Notify helper posts the banner; clicking it brings DSH forward. It needs a notification permission once — request it explicitly with Request notification permission; a notification never opens that dialog itself. Unauthorized falls back to the compatible channel.',
        switchScheduledName: 'Also announce scheduled runs',
        switchScheduledHint: 'Off by default: sessions created by the scheduling plugin skip finish and error reminders, so a broken one-minute task cannot fill the notification center.',
      },
    }

    /** Switch definitions rendered in order; copy comes from the dictionary. */
    const SWITCHES = [
      { key: 'enabled', nameKey: 'switchEnabledName', hintKey: 'switchEnabledHint' },
      { key: 'approvals', nameKey: 'switchApprovalsName', hintKey: 'switchApprovalsHint' },
      { key: 'questions', nameKey: 'switchQuestionsName', hintKey: 'switchQuestionsHint' },
      { key: 'finishes', nameKey: 'switchFinishesName', hintKey: 'switchFinishesHint' },
      { key: 'errors', nameKey: 'switchErrorsName', hintKey: 'switchErrorsHint' },
      { key: 'sound', nameKey: 'switchSoundName', hintKey: 'switchSoundHint' },
      { key: 'skipWhenFocused', nameKey: 'switchFocusedName', hintKey: 'switchFocusedHint' },
      { key: 'idleOnly', nameKey: 'switchIdleName', hintKey: 'switchIdleHint' },
      { key: 'clickable', nameKey: 'switchClickableName', hintKey: 'switchClickableHint' },
      { key: 'scheduled', nameKey: 'switchScheduledName', hintKey: 'switchScheduledHint' },
    ]

    /** Fill `{name}` placeholders in one translated template. */
    function fill(template, variables) {
      return String(template ?? '').replace(/\{([a-zA-Z]+)\}/gu, (match, key) =>
        (variables !== undefined && key in variables ? String(variables[key]) : match))
    }

    /** Fallback translator used before or without the locale service. */
    const fallbackLanguage = String(typeof navigator === 'undefined' ? '' : navigator.language ?? '')
      .toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const fallback = key => UI[fallbackLanguage][key] ?? key

    /**
     * Read this plugin's settings namespace through the client settings channel.
     * @param {() => object | undefined} remote - resolves `ctx.remote` lazily.
     * @param {(view: object) => void} onView - receives the namespace view.
     * @param {(message: string) => void} onError - receives a readable failure.
     * @param {(key: string, variables?: object) => string} t - translator.
     */
    function createLoader(remote, onView, onError, t) {
      return async () => {
        let settings
        try {
          settings = remote()?.settings
        } catch (error) {
          onError(fill(t('errorChannel'), { reason: error?.message ?? error }))
          return
        }
        if (settings === undefined || typeof settings.describe !== 'function') {
          onError(t('errorNoRemote'))
          return
        }
        try {
          const described = await settings.describe()
          const view = (described?.namespaces ?? []).find(entry => entry?.ns === NS)
          if (view === undefined) {
            onError(fill(t('errorNoNamespace'), { ns: NS }))
            return
          }
          onView(view)
        } catch (error) {
          onError(fill(t('errorRead'), { reason: error?.message ?? error }))
        }
      }
    }

    /**
     * One labelled switch row.
     * @param {{ name: string, hint: string, value: boolean, disabled: boolean, onToggle: () => void, t: Function }} props - row props.
     */
    function Switch({ name, hint, value, disabled, onToggle, t }) {
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
        }, value ? t('pillOn') : t('pillOff')),
      )
    }

    /**
     * Notification settings page inside Settings → Plugins.
     * @param {object} props - slot props plus the lazy remote resolver and translator.
     */
    function PageView({ remote, t, locale }) {
      const [view, setView] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [, setLocaleRevision] = useState(0)

      // `bind()` reads the active locale at call time, but React needs a
      // subscription to re-render the mounted page when the user switches
      // languages in Settings → General.
      useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setLocaleRevision(value => value + 1))
      }, [locale])

      const load = useCallback(
        createLoader(remote, next => { setView(next); setError(null) }, message => setError(message), t),
        [remote, t],
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
          setError(t('errorNoRemote'))
          return
        }
        setBusy(true)
        try {
          await settings.update(NS, patch)
          await new Promise(resolve => setTimeout(resolve, 1400))
          await load()
        } catch (caught) {
          setError(fill(t('errorWrite'), { reason: caught?.message ?? caught }))
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
          h('div', { style: styles.label }, t('labelStatus')),
          h('div', { style: styles.status }, status === '' ? t('statusEmpty') : status),
          details === '' ? null : h('div', { style: styles.detail }, details),
        ),
        h('div', { style: styles.card },
          h('div', { style: styles.label }, t('labelMoments')),
          ...SWITCHES.map(entry => h(Switch, {
            key: entry.key,
            name: t(entry.nameKey),
            hint: t(entry.hintKey),
            value: values[entry.key] !== false,
            disabled: busy,
            t,
            onToggle: () => void write({ [entry.key]: values[entry.key] === false }),
          })),
        ),
        h('div', { style: styles.row },
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void write({ authorizeNow: true }),
          }, t('buttonAuthorize')),
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void write({ testNow: true }),
          }, t('buttonTest')),
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void write({ diagnoseNow: true }),
          }, t('buttonDiagnose')),
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void write({ openSettingsNow: true }),
          }, t('buttonSettings')),
          h('button', {
            style: busy ? { ...styles.button, ...styles.busy } : styles.button,
            disabled: busy,
            onClick: () => void load(),
          }, t('buttonRefresh')),
        ),
        h('div', { style: styles.hint }, t('hintBanner')),
        enabled ? null : h('div', { style: styles.hint }, t('hintMasterOff')),
        error === null ? null : h('div', { style: styles.error }, error),
        view === null ? null : h('details', {},
          h('summary', { style: styles.hint }, t('rawSummary')),
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

        // Register the dictionary with the client locale service when it exists;
        // otherwise the page keeps the Chinese baseline.
        let t = fallback
        let locale
        try {
          locale = ctx.locale ?? (typeof ctx.get === 'function' ? ctx.get('locale') : undefined)
          if (locale !== undefined && typeof locale.register === 'function') {
            const register = () => locale.register(NS, UI)
            if (typeof ctx.effect === 'function') ctx.effect(register)
            else register()
            if (typeof locale.bind === 'function') {
              const bound = locale.bind(NS)
              const translate = typeof bound === 'function'
                ? bound
                : typeof bound?.t === 'function' ? bound.t.bind(bound) : undefined
              if (translate !== undefined) t = key => translate(key)
            }
          }
        } catch {}

        /** Mirror the active UI language into the Host so it can localize notifications. */
        const reportLocale = async () => {
          try {
            const settings = remote()?.settings
            if (settings === undefined || typeof settings.describe !== 'function'
              || typeof settings.update !== 'function') return
            const language = String(document.documentElement?.lang ?? navigator.language ?? '')
            const next = language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
            const described = await settings.describe()
            const current = (described?.namespaces ?? []).find(entry => entry?.ns === NS)?.value?.clientLocale
            if (current !== next) await settings.update(NS, { clientLocale: next })
          } catch {}
        }
        reportLocale()
        try {
          if (locale !== undefined && typeof locale.subscribe === 'function' && typeof ctx.effect === 'function') {
            ctx.effect(() => locale.subscribe(() => { void reportLocale() }))
          }
        } catch {}
        try {
          if (typeof MutationObserver === 'function' && typeof ctx.effect === 'function') {
            const observer = new MutationObserver(reportLocale)
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
            ctx.effect(() => () => observer.disconnect())
          }
        } catch {}

        const Page = () => h(PageView, { remote, t, locale })
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'approval-notify',
          order: 56,
          label: t('tab'),
        }, Page))
      },
    }
  },
})