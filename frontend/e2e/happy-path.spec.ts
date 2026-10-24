import { expect, test } from '@playwright/test'

/**
 * The whole story in one go: sign up, finish onboarding, open a sample project,
 * ask Kaat to remove filler words, apply the edit, undo it, then export.
 * Everything runs against the mock API, so no backend is needed.
 */
test('sign up, edit by chat, undo, export', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Sign up
  await page.goto('/signup')
  await page.getByLabel('Name').fill('Asha')
  await page.getByLabel('Email').fill('asha@example.com')
  await page.getByLabel('Password', { exact: true }).fill('password123')
  await page
    .getByRole('button', { name: /create|sign up/i })
    .first()
    .click()

  // Onboarding: language, content type, skip Instagram
  await expect(page).toHaveURL(/onboarding/)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /skip for now/i }).click()

  // Dashboard: add sample projects, open one
  await expect(page).toHaveURL(/\/app$/)
  await page.getByRole('button', { name: /add sample projects/i }).click()
  await page
    .getByRole('link', { name: /Open Funding kaise/ })
    .first()
    .click({ force: true })
  await expect(page).toHaveURL(/\/app\/project\/p_funding/)

  // Chat: ask for filler removal, apply, check the cut count, undo
  const duration = page.getByText(/\/ 04:55\.0/)
  await expect(duration).toBeVisible()
  const box = page.getByRole('textbox').first()
  await box.fill('filler hata do')
  await box.press('Enter')
  await expect(page.getByText(/filler words hatao/i)).toBeVisible()
  await page
    .getByRole('button', { name: /^apply/i })
    .first()
    .click()
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/\/ 04:47\.9/)).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(duration).toBeVisible()

  // Export: run the (simulated) render and download both files
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page).toHaveURL(/\/export$/)
  await page.getByRole('button', { name: /^Export Reel/ }).click()
  const [video] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByRole('button', { name: /Download MP4/ }).click({ timeout: 30_000 }),
  ])
  expect(video.suggestedFilename()).toMatch(/\.mp4$/)
  await page.getByRole('tab', { name: 'Editor project' }).click()
  const [otio] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click(),
  ])
  expect(otio.suggestedFilename()).toMatch(/\.otio$/)

  expect(errors).toEqual([])
})
