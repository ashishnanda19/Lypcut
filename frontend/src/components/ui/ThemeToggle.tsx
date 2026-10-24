import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { IconButton } from './IconButton'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const dark = theme === 'dark'
  return (
    <IconButton
      label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      variant="secondary"
      onClick={toggle}
    >
      {dark ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </IconButton>
  )
}
