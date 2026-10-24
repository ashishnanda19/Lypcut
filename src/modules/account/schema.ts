import { z } from 'zod'

export const langSchema = z.enum(['hi', 'hinglish', 'en'])
export const contentTypeSchema = z.enum(['youtuber', 'business', 'clipper'])

/** The front end's `User` type (src/types/index.ts). */
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  language: langSchema,
  contentType: contentTypeSchema.nullable(),
  onboarded: z.boolean(),
  plan: z.enum(['free', 'creator', 'studio']),
})
export type UserDto = z.infer<typeof userSchema>

export const updateMeBody = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(80, 'Use a shorter name.').optional(),
  language: langSchema.optional(),
  contentType: contentTypeSchema.nullable().optional(),
  /** Set once onboarding finishes. It cannot be switched back off. */
  onboarded: z.literal(true).optional(),
})

export const okSchema = z.object({ ok: z.literal(true) })
