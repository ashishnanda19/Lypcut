import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { signUp } from './helpers/auth'
import { speechVideo } from './helpers/speech'

/**
 * Style against the real backend, with no Meta app and no API key: the stand-in Instagram and the offline model.
 *   1. Upload Reels by hand, with their numbers, and see a profile; ask for "match my style" in a project; apply, undo.
 *   2. Connect Instagram through the stand-in consent screen: a personal account is turned away with the free-switch message,
 *      a Creator account connects and its Reels appear; "Reconnect" shows when the connection expires; disconnect clears it.
 * Needs the backend running with APP_URL set to this page's address (see playwright.real.config.ts).
 */

const pg = (sql: string) =>
  execFileSync(
    'docker',
    [
      'exec',
      process.env.E2E_PG_CONTAINER ?? 'lypcut-postgres-1',
      'psql',
      '-U',
      'lypcut',
      '-d',
      'lypcut',
      '-c',
      sql,
    ],
    {
      stdio: 'ignore',
    },
  )

const api = (page: Page, p: string) => page.request.get(`/api${p}`).then((r) => r.json())

test('real backend: upload Reels, see a style, match it in the editor', async ({ page }) => {
  const video = speechVideo()
  test.skip(
    !video,
    'Needs a video with speech: set E2E_VIDEO, or run on macOS with ffmpeg installed.',
  )
  // Learning from three Reels, and then processing a project, each take a couple of minutes on a laptop.
  test.setTimeout(720_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Three Reels, which here are the same talk saved under three names.
  const dir = path.join(tmpdir(), 'lypcut-e2e-reels')
  mkdirSync(dir, { recursive: true })
  const reels = ['best.mp4', 'second.mp4', 'third.mp4'].map((name) => {
    const f = path.join(dir, name)
    copyFileSync(video!, f)
    return f
  })

  await signUp(page, 'e2e-style')
  await page.goto('/app/style')
  await expect(page.getByRole('heading', { name: 'Your style' })).toBeVisible()
  // No simulated-connection note against the real backend, and no Music card.
  await expect(page.getByText(/simulated connection/)).toHaveCount(0)

  // Pick the files and paste their numbers.
  await page.getByTestId('reel-input').setInputFiles(reels)
  await expect(page.getByText('best.mp4')).toBeVisible()
  await page.getByRole('button', { name: /Add your numbers/ }).click()
  await page
    .getByLabel('Your numbers')
    .fill(
      [
        'file,views,likes,comments,saves,shares,watched',
        'best.mp4,48200,3100,210,980,640,74',
        'second,31000,2200,120,1400,410,68',
        'third.mp4,9000,300,20,30,10,31',
      ].join('\n'),
    )
  await expect(page.getByText('Numbers found for 3 of your Reels.')).toBeVisible()
  await page.getByRole('button', { name: 'Learn my style' }).click()

  // The files go up, then the learning is followed live, then the profile appears.
  await expect(page.getByText('Learning your style').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Learned from uploaded Reels')).toBeVisible({ timeout: 420_000 })
  await expect(page.getByText('3 Reels analysed')).toBeVisible()
  await expect(page.getByText('This is a first guess')).toBeVisible()
  await expect(page.getByText('Music', { exact: true })).toHaveCount(0)

  const profile = await api(page, '/style')
  expect(profile).toMatchObject({ connected: true, source: 'upload', reelsAnalysed: 3, music: [] })
  // The talk starts speaking at once, so the hook lands at 0 seconds: a measurement, not a missing one.
  expect(profile.hookTimingSec).toBeGreaterThanOrEqual(0)
  expect(profile.cutPace).toBeGreaterThanOrEqual(0)

  // Each Reel shows its picture and its numbers; the videos themselves are gone.
  await expect(page.getByText('48.2K')).toBeVisible()
  const list = (await api(page, '/style/reels')) as Array<{ thumbUrl?: string; title: string }>
  expect(list.map((r) => r.title).sort()).toEqual(['best', 'second', 'third'])
  const thumb = await page.request.get(list[0]!.thumbUrl!)
  expect(thumb.ok()).toBe(true)
  expect(thumb.headers()['content-type']).toMatch(/image\/jpeg/)

  // Ask the assistant to match it, in a project.
  await page.goto('/app')
  await page.getByTestId('video-input').setInputFiles(video!)
  await expect(page).toHaveURL(/\/app\/project\/[0-9a-f-]{36}/, { timeout: 60_000 })
  const projectId = page.url().match(/project\/([0-9a-f-]{36})/)![1]!
  await expect(page.getByRole('button', { name: 'Export' })).toBeVisible({ timeout: 180_000 })
  const chat = page.getByRole('log', { name: 'Conversation' })
  const box = page.getByRole('textbox').first()
  await box.fill('meri style lagao')
  await box.press('Enter')
  const card = chat.locator('[aria-label^="Edit:"]').last()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByText(/Match my style|Meri style lagao/)).toBeVisible()
  // The card says what it did. These Reels' captions were not one of the editor's looks, so it says it kept the current look.
  await expect(card.getByText(/caption look|captions/i).first()).toBeVisible()
  await card.getByRole('button', { name: 'Apply' }).click()
  await expect(card.getByText('Applied', { exact: true }).first()).toBeVisible()
  // Saved on the server a moment after it lands on screen.
  await expect
    .poll(
      async () =>
        ((await api(page, `/projects/${projectId}/timeline`)) as { version: number }).version,
    )
    .toBe(1)
  const history = (await api(page, `/projects/${projectId}/timeline/history`)) as {
    versions: Array<{ n: number; author: string }>
  }
  expect(history.versions.find((v) => v.n === 1)?.author).toBe('ai')
  await card.getByRole('button', { name: 'Undo' }).click()
  await expect
    .poll(
      async () =>
        ((await api(page, `/projects/${projectId}/timeline`)) as { version: number }).version,
    )
    .toBe(0)

  // Remove one Reel, then disconnect: everything goes.
  await page.goto('/app/style')
  await page.getByRole('button', { name: 'Remove third' }).click()
  await expect(page.getByText('2 Reels analysed')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('heading', { name: /Teach .* your style/ })).toBeVisible()
  expect(await api(page, '/style')).toMatchObject({ connected: false, reelsAnalysed: 0 })
  expect(await api(page, '/style/reels')).toEqual([])

  expect(errors).toEqual([])
})

test('real backend: connect Instagram with the stand-in, see the states, reconnect, disconnect', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await signUp(page, 'e2e-ig')
  await page.goto('/app/style')

  // Say plainly what is read, then go to Instagram.
  await page.getByRole('button', { name: 'Connect Instagram' }).click()
  const before = page.getByRole('group', { name: 'Before you connect' })
  await expect(before.getByText(/Post, comment, message or change anything/)).toBeVisible()
  await expect(before.getByText(/learns your style/)).toBeVisible()
  await before.getByRole('button', { name: 'Continue to Instagram' }).click()

  // A personal account cannot be read: the page says how to switch, and offers the upload instead.
  await expect(page).toHaveURL(/fake-instagram\/authorize/)
  await page.getByRole('link', { name: 'Continue as a personal account' }).click()
  await expect(page).toHaveURL(/\/app\/style$/)
  await expect(page.getByText('Switch to a Creator account, it is free')).toBeVisible()
  await expect(page.getByText('No Instagram? Upload Reels instead')).toBeVisible()
  expect(await api(page, '/style')).toMatchObject({ connected: false })

  // Cancelling is not an error.
  await page.getByRole('button', { name: 'Connect Instagram' }).click()
  await page.getByRole('button', { name: 'Continue to Instagram' }).click()
  await page.getByRole('link', { name: 'Cancel' }).click()
  await expect(page.getByText('You cancelled on Instagram')).toBeVisible()

  // A Creator account connects, and its Reels and their numbers appear.
  await page.getByRole('button', { name: 'Connect Instagram' }).click()
  await page.getByRole('button', { name: 'Continue to Instagram' }).click()
  await page.getByRole('link', { name: 'Continue as a Creator account' }).click()
  await expect(page.getByText('Connected to Instagram @aarav.builds')).toBeVisible({
    timeout: 60_000,
  })
  await expect
    .poll(async () => ((await api(page, '/style/reels')) as unknown[]).length, { timeout: 90_000 })
    .toBeGreaterThanOrEqual(10)
  await page.reload()
  await expect(page.getByText(/Reel · \d+ \w+ 20\d\d/).first()).toBeVisible()
  // Instagram has the numbers but not the videos: the page asks for the files of the best few.
  await expect(page.getByText('Add your best Reels').first()).toBeVisible()
  expect(await api(page, '/style/status')).toMatchObject({ needs: 'reel_files' })
  // The connection is never shown to the page: no token anywhere in what it received.
  const html = await page.content()
  expect(html).not.toMatch(/fake-long|fake-short|token_envelope/)

  // The connection expires: the page says Reconnect, keeps showing what was read, and reconnecting fixes it.
  pg("update instagram_accounts set status = 'reauth_required'")
  await page.reload()
  await expect(page.getByText('Reconnect Instagram')).toBeVisible()
  await expect(page.getByText('Connected to Instagram @aarav.builds')).toBeVisible()
  await page.getByRole('button', { name: 'Reconnect' }).click()
  await page.getByRole('link', { name: 'Continue as a Creator account' }).click()
  await expect(page.getByText('Instagram connected')).toBeVisible()
  await expect(page.getByText('Reconnect Instagram')).toHaveCount(0)

  // Disconnect removes it all.
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('heading', { name: /Teach .* your style/ })).toBeVisible()
  expect(await api(page, '/style')).toMatchObject({ connected: false })
  expect(await api(page, '/style/reels')).toEqual([])

  expect(errors).toEqual([])
})
