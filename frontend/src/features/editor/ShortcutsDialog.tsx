import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { KeyboardShortcutHint } from '@/components/domain/KeyboardShortcutHint'
import { SHORTCUT_GROUPS } from './useEditorShortcuts'

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Keyboard shortcuts"
        description="Everything works without a mouse."
        size="lg"
      >
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} aria-labelledby={`sc-${g.title}`}>
              <h3
                id={`sc-${g.title}`}
                className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint"
              >
                {g.title}
              </h3>
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <li key={i.label} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted">{i.label}</span>
                    <KeyboardShortcutHint keys={i.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
