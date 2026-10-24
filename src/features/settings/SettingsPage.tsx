import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Image as ImageIcon, LogOut, Trash2 } from 'lucide-react'
import { api } from '@/api/client'
import { useConnectStyle, useDisconnectStyle, useStyle } from '@/api/hooks'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { toast } from '@/components/ui/Toast'
import { clearSession } from '@/features/editor/store'
import { useAuth } from '@/stores/auth'
import { useBrand } from '@/stores/brand'
import { usePrefs } from '@/stores/prefs'
import type { Lang } from '@/types'

const LANGS = [
  { value: 'hinglish', label: 'Hinglish', hint: 'Hindi in Roman letters mixed with English' },
  { value: 'hi', label: 'हिन्दी', hint: 'Hindi in Devanagari' },
  { value: 'en', label: 'English' },
]
const FONTS = ['Inter', 'Noto Sans Devanagari', 'Poppins', 'Hind', 'Mukta', 'Baloo 2'].map((f) => ({
  value: f,
  label: f,
}))

function Section({
  id,
  title,
  note,
  children,
}: {
  id?: string
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id ?? title}-h`}
      className="scroll-mt-24 rounded-panel border border-line bg-surface-1 p-6"
    >
      <h2 id={`${id ?? title}-h`} className="text-lg font-semibold">
        {title}
      </h2>
      {note && <p className="mt-1 text-sm text-muted">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
  )
}

function Profile() {
  const user = useAuth((s) => s.user)
  const update = useAuth((s) => s.update)
  const [name, setName] = useState(user?.name ?? '')
  const [lang, setLang] = useState<string>(user?.language ?? 'hinglish')
  const dirty = name.trim() !== user?.name || lang !== user?.language
  const save = () => {
    if (!name.trim()) return
    update({ name: name.trim(), language: lang as Lang })
    toast({ title: 'Profile saved', tone: 'success' })
  }
  return (
    <Section title="Profile" note="Your name and the language Kaat talks to you in.">
      <div className="grid max-w-xl gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={name.trim() ? undefined : 'Please enter your name'}
        />
        <Input
          label="Email"
          value={user?.email ?? ''}
          readOnly
          hint="Email cannot be changed in this demo."
        />
        <Select value={lang} onValueChange={setLang} label="Language" options={LANGS} />
        <div>
          <Button variant="primary" disabled={!dirty || !name.trim()} onClick={save}>
            Save changes
          </Button>
        </div>
      </div>
    </Section>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const ok = /^#[0-9a-f]{6}$/i.test(value)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-medium text-muted">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={ok ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="size-11 shrink-0 cursor-pointer rounded-control border border-line bg-transparent p-1"
        />
        <Input
          hideLabel
          label={`${label} hex`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          error={ok ? undefined : 'Use #rrggbb'}
          className="min-w-0 flex-1"
          maxLength={7}
        />
      </div>
    </div>
  )
}

function BrandKit() {
  const brand = useBrand()
  const file = useRef<HTMLInputElement>(null)
  return (
    <Section
      id="brand"
      title="Brand kit"
      note="Kaat uses these for captions, titles and end cards. Saved on this device."
    >
      <div className="grid max-w-2xl gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            value={brand.fonts.heading}
            onValueChange={(v) => brand.set({ fonts: { ...brand.fonts, heading: v } })}
            label="Heading font"
            options={FONTS}
          />
          <Select
            value={brand.fonts.body}
            onValueChange={(v) => brand.set({ fonts: { ...brand.fonts, body: v } })}
            label="Body font"
            options={FONTS}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <ColorField
            label="Primary"
            value={brand.colors.primary}
            onChange={(v) => brand.set({ colors: { ...brand.colors, primary: v } })}
          />
          <ColorField
            label="Accent"
            value={brand.colors.accent}
            onChange={(v) => brand.set({ colors: { ...brand.colors, accent: v } })}
          />
          <ColorField
            label="Text"
            value={brand.colors.text}
            onChange={(v) => brand.set({ colors: { ...brand.colors, text: v } })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={file}
            type="file"
            accept="image/png,image/svg+xml,image/jpeg"
            className="sr-only"
            aria-label="Upload logo"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) brand.set({ logoName: f.name })
            }}
          />
          <Button
            leading={<ImageIcon className="size-4" aria-hidden="true" />}
            onClick={() => file.current?.click()}
          >
            {brand.logoName ? 'Replace logo' : 'Add logo'}
          </Button>
          <span className="text-sm text-muted">
            {brand.logoName ?? 'No logo yet. PNG, SVG or JPG.'}
          </span>
          {brand.logoName && (
            <Button variant="ghost" size="sm" onClick={() => brand.set({ logoName: null })}>
              Remove
            </Button>
          )}
        </div>
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              brand.reset()
              toast({ title: 'Brand kit reset', tone: 'info' })
            }}
          >
            Reset to defaults
          </Button>
        </div>
      </div>
    </Section>
  )
}

function Accounts() {
  const style = useStyle()
  const connect = useConnectStyle()
  const disconnect = useDisconnectStyle()
  const on = !!style.data?.connected && style.data.source === 'instagram'
  return (
    <Section title="Connected accounts">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface-2 p-4">
        <div>
          <p className="text-sm font-semibold">Instagram</p>
          <p className="text-[13px] text-muted">
            {on
              ? `Connected as ${style.data?.handle ?? 'your account'}`
              : 'Not connected. Read-only, we never post for you.'}
          </p>
        </div>
        {on ? (
          <Button loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
            Disconnect
          </Button>
        ) : (
          <Button variant="primary" loading={connect.isPending} onClick={() => connect.mutate()}>
            Connect
          </Button>
        )}
      </div>
    </Section>
  )
}

function Plan() {
  const plan = useAuth((s) => s.user?.plan ?? 'free')
  return (
    <Section title="Plan and usage" note="Illustrative numbers. Billing is not live in this build.">
      <div className="grid max-w-xl gap-5">
        <div className="flex items-center gap-3">
          <Badge tone="saffron">
            {plan === 'free' ? 'Free' : plan === 'creator' ? 'Creator' : 'Studio'}
          </Badge>
          <Button size="sm" disabled>
            Upgrade (coming soon)
          </Button>
        </div>
        <div>
          <p className="mb-1.5 flex justify-between text-[13px]">
            <span>Video processed</span>
            <span className="tnum text-muted">38 / 60 min</span>
          </p>
          <ProgressBar label="Video processed" value={63} />
        </div>
        <div>
          <p className="mb-1.5 flex justify-between text-[13px]">
            <span>Exports this month</span>
            <span className="tnum text-muted">4 / 10</span>
          </p>
          <ProgressBar label="Exports this month" value={40} tone="teal" />
        </div>
      </div>
    </Section>
  )
}

function Preferences() {
  const advanced = usePrefs((s) => s.advanced)
  const setAdvanced = usePrefs((s) => s.setAdvanced)
  return (
    <Section title="Editor">
      <Switch
        checked={advanced}
        onCheckedChange={setAdvanced}
        label="Advanced mode by default"
        hint="Shows effects and overlay tracks and the full property controls."
      />
    </Section>
  )
}

function DangerZone() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const logout = useAuth((s) => s.logout)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mounted, setMounted] = useState(true)
  useEffect(() => () => setMounted(false), [])
  const signOut = () => {
    logout()
    qc.clear()
    navigate('/')
  }
  const wipe = async () => {
    setBusy(true)
    try {
      await api.delete('/me')
      useBrand.getState().reset()
      qc.getQueryCache()
        .getAll()
        .forEach((q) => {
          const k = q.queryKey[1]
          if (typeof k === 'string') clearSession(k)
        })
      signOut()
      toast({ title: 'Your data was deleted', tone: 'success' })
    } catch {
      if (mounted) setBusy(false)
      toast({
        title: 'Could not delete your data',
        description: 'Please try again.',
        tone: 'error',
      })
    }
  }
  return (
    <Section title="Account and data">
      <div className="flex flex-wrap gap-3">
        <Button leading={<LogOut className="size-4" aria-hidden="true" />} onClick={signOut}>
          Log out
        </Button>
        <Button
          variant="danger"
          leading={<Trash2 className="size-4" aria-hidden="true" />}
          onClick={() => setOpen(true)}
        >
          Delete all my data
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Delete all your data?"
          description="This removes your projects, learned style and brand kit, and logs you out. It cannot be undone."
          size="sm"
        >
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void wipe()}>
              Delete everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  )
}

export function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-3xl font-semibold">Settings</h1>
      <div className="mt-6 flex flex-col gap-5">
        <Profile />
        <BrandKit />
        <Preferences />
        <Accounts />
        <Plan />
        <DangerZone />
      </div>
    </div>
  )
}

export default SettingsPage
