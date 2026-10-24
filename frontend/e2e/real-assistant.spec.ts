import { expect, test } from '@playwright/test'
import { speechVideo } from './helpers/speech'

/**
 * The assistant against the real backend (no API key needed: the backend uses its offline model): ask for a Reel in
 * Hinglish, answer the three questions, preview it, apply it, take it back, then search by meaning and see the hooks.
 * Needs the backend running (`docker compose up` in ../backend) and a video with speech.
 */
test('real backend: ask for a Reel, answer, preview, apply, undo, search by meaning, hooks', async ({
  page,
}) => {
  const video = speechVideo()
  test.skip(
    !video,
    'Needs a video with speech: set E2E_VIDEO, or run on macOS with ffmpeg installed.',
  )
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  const email = `e2e-ai-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
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

  await page.getByTestId('video-input').setInputFiles(video!)
  await expect(page).toHaveURL(/\/app\/project\/[0-9a-f-]{36}/, { timeout: 60_000 })
  const projectId = page.url().match(/project\/([0-9a-f-]{36})/)![1]!
  await expect(page.getByRole('button', { name: 'Export' })).toBeVisible({ timeout: 180_000 })

  const api = (path: string) => page.request.get(`/api/projects/${projectId}${path}`)
  const version = async () =>
    ((await (await api('/timeline')).json()) as { version: number }).version
  const plans = async () =>
    (await (await api('/plans')).json()) as Array<{ id: string; status: string }>

  // The hooks the server found are on the Clips tab.
  const hooks = (await (await api('/highlights')).json()) as unknown[]
  expect(hooks.length).toBeGreaterThan(0)
  await page.getByRole('tab', { name: 'Clips' }).click()
  await expect(page.getByRole('button', { name: /make a reel/i }).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Chat' }).click()

  // Ask for a Reel in Hinglish. The assistant asks which part, how long, and what pace.
  const chat = page.getByRole('log', { name: 'Conversation' })
  const box = page.getByRole('textbox').first()
  await box.fill('ek Reel banao')
  await box.press('Enter')
  for (let step = 0; step < 3; step++) {
    const question = chat.getByRole('group').nth(step)
    const option = question.getByRole('button').first()
    await expect(option).toBeEnabled({ timeout: 30_000 })
    await option.click()
  }

  // Then an Edit card with the plan. Previewing it changes nothing on the server.
  const card = chat.locator('[aria-label^="Edit:"]').last()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Preview' }).click()
  await expect(card.getByText('Previewing')).toBeVisible()
  expect(await version()).toBe(0)
  const [plan] = await plans()
  expect(plan).toMatchObject({ status: 'proposed' })

  // Applying it is saved as a version by the assistant, linked to the plan.
  await card.getByRole('button', { name: 'Apply' }).click()
  await expect(card.getByText('Applied', { exact: true }).first()).toBeVisible()
  await expect.poll(version).toBe(1)
  const history = (await (await api('/timeline/history')).json()) as {
    versions: Array<{ n: number; author: string; editId?: string }>
  }
  expect(history.versions.find((v) => v.n === 1)).toMatchObject({
    author: 'ai',
    editId: plan!.id,
  })
  await expect.poll(async () => (await plans())[0]!.status).toBe('applied')

  // Undo takes it back, and the server's copy of the plan says so.
  await card.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(version).toBe(0)
  await expect.poll(async () => (await plans())[0]!.status).toBe('undone')

  // Search by meaning: no word of the query is in the talk, but the moment is found.
  await page.getByRole('tab', { name: 'Search' }).click()
  await page.getByRole('searchbox').fill('a mistake with spending money')
  await expect(page.getByRole('button', { name: /make a reel/i }).first()).toBeVisible({
    timeout: 30_000,
  })

  expect(errors).toEqual([])
})
