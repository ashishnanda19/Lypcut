import { expect, type Page } from '@playwright/test'

/** Signs up a new person through the real forms and gets through onboarding, ending on the dashboard. */
export async function signUp(page: Page, prefix = 'e2e') {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
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
