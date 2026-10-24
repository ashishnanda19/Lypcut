import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { longVideo, speechVideo } from './helpers/speech'

/**
 * The same story as the mock happy path, but every request goes to the real backend: sign up, upload a video,
 * wait for it to be transcribed, edit it, and check the edit is really saved on the server.
 * Needs the backend running (`docker compose up` in ./backend) and a video with speech
 * (macOS makes one itself; otherwise set E2E_VIDEO).
 */
test('real backend: sign up, upload, process, edit, undo, reload, export', async ({ page }) => {
  const video = speechVideo()
  test.skip(
    !video,
    'Needs a video with speech: set E2E_VIDEO, or run on macOS with ffmpeg installed.',
  )

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Sign up with a password the backend accepts.
  const email = `e2e-${Date.now()}@example.com`
  await page.goto('/signup')
  await page.getByLabel('Name').fill('Asha')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByRole('button', { name: /create/i }).click()
  await expect(page.getByText(/at least 8 characters/i)).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await page.getByRole('button', { name: /create/i }).click()

  // Onboarding, which the server remembers.
  await expect(page).toHaveURL(/onboarding/)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /skip for now/i }).click()
  await expect(page).toHaveURL(/\/app$/)

  // A new account has no projects, and no sample-project shortcut.
  await expect(page.getByText('No projects yet')).toBeVisible()
  await expect(page.getByRole('button', { name: /add sample projects/i })).toHaveCount(0)

  // Upload the video for real: parts go straight to storage, then the server checks the file.
  await page.getByTestId('video-input').setInputFiles(video!)
  await expect(page).toHaveURL(/\/app\/new/)
  await expect(page).toHaveURL(/\/app\/project\/[0-9a-f-]{36}/, { timeout: 60_000 })
  const projectId = page.url().match(/project\/([0-9a-f-]{36})/)![1]!

  // Processing runs in the worker; the page follows it live and opens the editor when it is done.
  await expect(page.getByRole('button', { name: 'Export' })).toBeVisible({ timeout: 180_000 })

  // The video plays from a short-lived link in storage, not through the API.
  const src = await page.locator('video').first().getAttribute('src')
  expect(src).toMatch(/X-Amz-Signature=/)

  // The timeline came from the server.
  const state = async () =>
    (await (await page.request.get(`/api/projects/${projectId}/timeline`)).json()) as {
      version: number
      canUndo: boolean
      canRedo: boolean
      timeline: { items: Record<string, unknown> }
    }
  const first = await state()
  expect(first.version).toBe(0)
  const clips = Object.keys(first.timeline.items).length

  // Split at the playhead. It lands in the editor at once and on the server a moment later.
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('s')
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  await expect.poll(async () => (await state()).version).toBe(1)
  expect(Object.keys((await state()).timeline.items).length).toBeGreaterThan(clips)

  // Undo and redo are saved too.
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await state()).version).toBe(0)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(async () => (await state()).version).toBe(1)

  // Reload: the edit is still there, and Undo still works from the saved history.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Export' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  await page.getByRole('tab', { name: 'History' }).click()
  await expect(page.getByText('1 change')).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await state()).version).toBe(0)

  // The project file is written by the server from the saved timeline.
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('tab', { name: 'Editor project' }).click()
  const [otio] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])
  expect(otio.suggestedFilename()).toMatch(/\.otio$/)
  const file = JSON.parse(readFileSync((await otio.path())!, 'utf8')) as { OTIO_SCHEMA?: string }
  expect(file.OTIO_SCHEMA).toMatch(/^Timeline\.1/)

  expect(errors).toEqual([])
})

/** Signs up and gets through onboarding, ending on the dashboard. */
async function signUp(page: Page) {
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  await page.goto('/signup')
  await page.getByLabel('Name').fill('Asha')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await page.getByRole('button', { name: /create/i }).click()
  await expect(page).toHaveURL(/onboarding/)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /skip for now/i }).click()
  await expect(page).toHaveURL(/\/app$/)
  return email
}

test('real backend: sessions, wrong passwords and signing out', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const email = await signUp(page)

  // The short-lived access cookie goes missing (it expires after 15 minutes): the app renews it quietly.
  await context.clearCookies({ name: 'lypcut_at' })
  await page.reload()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText('No projects yet')).toBeVisible()
  expect((await context.cookies()).some((c) => c.name === 'lypcut_at')).toBe(true)

  // Signing out ends the session on the server too.
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page).toHaveURL('/')
  await page.goto('/app')
  await expect(page).toHaveURL(/\/login/)

  // A wrong password says so without naming which part was wrong.
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('not-the-password')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByText('That email or password is not right.')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/app$/)

  // A browser that kept an old sign-in but lost its cookies is sent to log in, not shown a broken page.
  await context.clearCookies()
  await page.reload()
  await expect(page).toHaveURL(/\/login/)

  expect(errors).toEqual([])
})

test('real backend: a video longer than the plan allows is refused and leaves nothing behind', async ({
  page,
}) => {
  const video = longVideo()
  test.skip(!video, 'Needs ffmpeg to make a long video.')
  await signUp(page)
  await page.getByTestId('video-input').setInputFiles(video!)
  await expect(page).toHaveURL(/\/app\/new/)
  await expect(page.getByRole('alert')).toContainText(/10 minutes|minutes/i, { timeout: 30_000 })
  // No Retry for a file that will never be accepted.
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  // The empty project the attempt created is gone.
  await page.goto('/app')
  await expect(page.getByText('No projects yet')).toBeVisible()
})
