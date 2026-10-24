import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Apply</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('is announced as busy and ignores clicks while loading', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Saving' })
    expect(btn).toHaveAttribute('aria-busy', 'true')
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    // pointer-events are off in CSS, so drive the handler directly as a keyboard user would.
    btn.focus()
    await userEvent.keyboard('{Enter}')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('is truly disabled when disabled', () => {
    render(<Button disabled>Apply</Button>)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
  })
})
