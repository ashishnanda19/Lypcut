import { memo, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check } from 'lucide-react'
import { ChatMessage } from '@/components/domain/ChatMessage'
import { EditCard } from '@/components/domain/EditCard'
import { PromptBox } from '@/components/domain/PromptBox'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { AI } from '@/lib/config'
import { uid } from '@/lib/ids'
import { rise } from '@/lib/motion'
import { useStreamedText } from '@/lib/useStreamedText'
import { useStyle } from '@/api/hooks'
import { isReal } from '@/lib/runtime'
import { useAuth } from '@/stores/auth'
import { usePrefs } from '@/stores/prefs'
import type { ChatMessage as Msg, Lang, QuestionCard } from '@/types'
import { answerAssistant, askAssistant, reelAssistant, type AssistantContext } from './assistant'
import { clock } from './clock'
import { useEditorData } from './data'
import { answerQuestion, plan, reelPlan, type PlannerContext, type PlannerResult } from './planner'
import { editStatus, headTimeline, useEditor } from './store'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Everything the planner needs to know right now. */
function usePlannerContext() {
  const data = useEditorData()
  const user = useAuth((s) => s.user)
  const applyStyle = usePrefs((s) => s.applyStyle)
  const { data: style } = useStyle()
  return useCallback(
    (): PlannerContext => ({
      tl: headTimeline(useEditor.getState()),
      tr: data.transcript,
      highlights: data.highlights,
      chapters: data.chapters,
      lang: (user?.language ?? 'hinglish') as Lang,
      style,
      applyStyle,
      playhead: clock.time,
    }),
    [data, user?.language, style, applyStyle],
  )
}

/** What the real assistant is told about where the person is. Read when a request is made, not on every render. */
function useAssistantContext() {
  const { project } = useEditorData()
  const lang = (useAuth((s) => s.user?.language) ?? 'hinglish') as Lang
  const applyStyle = usePrefs((s) => s.applyStyle)
  return useCallback(
    (): AssistantContext => ({
      projectId: project.id,
      playhead: clock.time,
      applyStyle,
      messages: useEditor.getState().messages,
      lang,
    }),
    [project.id, lang, applyStyle],
  )
}

function QuestionView({
  q,
  onAnswer,
  disabled,
}: {
  q: QuestionCard
  onAnswer: (id: string) => void
  disabled: boolean
}) {
  return (
    <motion.div
      variants={rise}
      initial="hidden"
      animate="show"
      role="group"
      aria-label={q.prompt}
      className="glass rounded-card p-3.5"
    >
      <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-faint">{q.prompt}</p>
      <div className="flex flex-col gap-2">
        {q.options.map((o) => {
          const picked = q.answer === o.id
          return (
            <button
              key={o.id}
              type="button"
              disabled={disabled || !!q.answer}
              aria-pressed={picked}
              onClick={() => onAnswer(o.id)}
              className={cn(
                'flex items-center gap-3 rounded-control border px-3.5 py-2.5 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]',
                picked
                  ? 'border-saffron bg-saffron-soft'
                  : 'border-line bg-surface-1 hover:border-saffron/50 hover:bg-surface-2 disabled:opacity-50',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{o.label}</span>
                {o.hint && <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>}
              </span>
              {picked ? (
                <Check className="size-4 text-accent" aria-hidden="true" />
              ) : (
                <ArrowRight className="size-4 text-faint" aria-hidden="true" />
              )}
            </button>
          )
        })}
      </div>
    </motion.div>
  )
}

function EditCardView({ editId }: { editId: string }) {
  const rec = useEditor((s) => s.edits[editId])
  const status = useEditor((s) => editStatus(s, editId))
  if (!rec) return null
  const { plan: p } = rec
  const store = useEditor.getState

  const focus = () => {
    if (p.focus !== undefined) clock.seek(Math.max(0, p.focus - 1))
  }
  return (
    <EditCard
      title={p.title}
      description={p.description}
      status={status}
      strip={p.strip}
      summary={p.summary}
      onPreview={() => {
        if (status === 'previewing') return void store().previewEdit(null)
        const err = store().previewEdit(editId)
        if (err)
          return void toast({ title: 'Cannot preview this', description: err, tone: 'error' })
        focus()
        clock.play()
      }}
      onApply={() => {
        const res = store().applyEdit(editId)
        if (!res.ok)
          return void toast({
            title: 'Could not apply this',
            description: res.error,
            tone: 'error',
          })
        focus()
        toast({
          title: 'Applied',
          description: p.title,
          tone: 'ai',
          actionLabel: 'Undo',
          onAction: () => store().undoEdit(editId),
        })
      }}
      onUndo={() => {
        const res = store().undoEdit(editId)
        if (!res.ok)
          toast({ title: "Can't undo that one directly", description: res.error, tone: 'error' })
      }}
    />
  )
}

/** One AI message: text streams in first, then the cards under it appear. */
const AiMessage = memo(function AiMessage({
  m,
  onAnswer,
  busy,
}: {
  m: Msg
  onAnswer: (m: Msg, optionId: string) => void
  busy: boolean
}) {
  const patch = useEditor((s) => s.patchMessage)
  const { text, done } = useStreamedText(m.text, { enabled: !!m.fresh })
  const navigate = useNavigate()
  useEffect(() => {
    if (done && m.fresh) patch(m.id, { fresh: false })
  }, [done, m.fresh, m.id, patch])
  return (
    <ChatMessage from="ai" text={text} streaming={!done}>
      {done && m.question && (
        <QuestionView q={m.question} disabled={busy} onAnswer={(id) => onAnswer(m, id)} />
      )}
      {done && m.editId && <EditCardView editId={m.editId} />}
      {done && m.link && (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          trailing={<ArrowRight className="size-3.5" aria-hidden="true" />}
          onClick={() => navigate(m.link!.to)}
        >
          {m.link.label}
        </Button>
      )}
    </ChatMessage>
  )
})

export function ChatPanel() {
  const messages = useEditor((s) => s.messages)
  const thinking = useEditor((s) => s.thinking)
  const ask = useEditor((s) => s.ask)
  const lang = (useAuth((s) => s.user?.language) ?? 'hinglish') as Lang
  const applyStyle = usePrefs((s) => s.applyStyle)
  const setApplyStyle = usePrefs((s) => s.setApplyStyle)
  const setTab = usePrefs((s) => s.setTab)
  const { data: style } = useStyle()
  const ctx = usePlannerContext()
  const actx = useAssistantContext()
  const listRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const s = useEditor

  const lastChips = [...messages].reverse().find((m) => m.from === 'ai' && m.chips)?.chips

  // Stay at the bottom as messages arrive.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, thinking])

  const deliver = useCallback(
    (res: PlannerResult) => {
      const st = s.getState()
      if (res.plan) st.registerEdit(res.plan)
      st.addMessage({
        id: uid('m'),
        from: 'ai',
        text: res.text,
        at: Date.now(),
        fresh: true,
        question: res.question,
        editId: res.plan?.id,
        chips: res.chips,
        link: res.route
          ? { label: res.route === '/app/style' ? 'Open Style page' : 'Open', to: res.route }
          : undefined,
      })
      if (res.action === 'undo') st.undo()
      if (res.action === 'redo') st.redo()
      if (res.open) {
        if (res.open.query !== undefined) st.setQuery(res.open.query)
        setTab(res.open.tab)
      }
    },
    [s, setTab],
  )

  /** Shows the thinking bubble while `make` works, then the answer. The stand-in pauses a moment so it feels like thinking. */
  const reply = useCallback(
    async (make: () => PlannerResult | Promise<PlannerResult>) => {
      s.getState().setThinking(true)
      if (!isReal) await sleep(520 + Math.random() * 420)
      const res = await make()
      s.getState().setThinking(false)
      deliver(res)
    },
    [s, deliver],
  )

  const send = useCallback(
    (text: string) => {
      // The assistant reads the conversation so far, so it is read before this message joins it.
      const c = actx()
      s.getState().addMessage({ id: uid('m'), from: 'user', text, at: Date.now() })
      void reply(() => (isReal ? askAssistant(c, text) : plan(text, ctx())))
    },
    [s, reply, ctx, actx],
  )

  const answer = useCallback(
    (m: Msg, optionId: string) => {
      const q = m.question
      if (!q) return
      const label = q.options.find((o) => o.id === optionId)?.label ?? optionId
      const c = actx()
      s.getState().patchMessage(m.id, { question: { ...q, answer: optionId } })
      s.getState().addMessage({ id: uid('m'), from: 'user', text: label, at: Date.now() })
      void reply(() =>
        isReal ? answerAssistant(c, q, optionId) : answerQuestion(q, optionId, ctx()),
      )
    },
    [s, reply, ctx, actx],
  )

  // Another panel asked the chat to do something (Make a Reel from a search result, and so on).
  const handled = useRef(0)
  useEffect(() => {
    if (!ask || handled.current === ask.id) return
    handled.current = ask.id
    s.getState().clearAsk()
    setTab('chat')
    const c = actx()
    s.getState().addMessage({ id: uid('m'), from: 'user', text: ask.text, at: Date.now() })
    if (ask.reel) {
      const r = ask.reel
      void reply(() =>
        isReal
          ? reelAssistant(c, r)
          : reelPlan(
              ctx(),
              { srcFrom: r.srcFrom, srcTo: r.srcTo, title: r.title, fast: true },
              lang,
            ),
      )
    } else {
      void reply(() => (isReal ? askAssistant(c, ask.text) : plan(ask.text, ctx())))
    }
  }, [ask, ctx, actx, lang, reply, s, setTab])

  const toggleStyle = (on: boolean) => {
    if (on && !style?.connected) {
      toast({
        title: 'No style learned yet',
        description: `Connect Instagram or upload a few Reels and ${AI.name} will match your style.`,
        actionLabel: 'Open Style',
        onAction: () => navigate('/app/style'),
      })
      return
    }
    setApplyStyle(on)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-1 pb-3">
        <Switch
          className="w-full"
          label="Apply my style"
          hint={
            style?.connected
              ? 'Captions and pace match your best Reels'
              : 'Connect Instagram on the Style page'
          }
          checked={applyStyle && !!style?.connected}
          onCheckedChange={toggleStyle}
        />
      </div>

      <div
        ref={listRef}
        aria-live="polite"
        aria-label="Conversation"
        role="log"
        className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-1 py-4"
      >
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.div key={m.id} variants={rise} initial="hidden" animate="show">
              {m.from === 'user' ? (
                <ChatMessage from="user" text={m.text} />
              ) : (
                <AiMessage m={m} onAnswer={answer} busy={thinking} />
              )}
            </motion.div>
          ))}
          {thinking && (
            <motion.div key="thinking" variants={rise} initial="hidden" animate="show" exit="exit">
              <ChatMessage from="ai" thinking />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-line pt-3">
        <PromptBox
          onSubmit={send}
          disabled={thinking}
          language={lang}
          suggestions={
            lastChips ?? [
              'Add captions',
              'Remove filler words',
              'Find my best hook',
              'Make a 30 second Reel',
              'Blur the background',
            ]
          }
          placeholder={
            lang === 'en'
              ? 'Tell me what to cut, find or fix…'
              : 'Batao kya cut, find ya fix karna hai…'
          }
        />
      </div>
    </div>
  )
}
