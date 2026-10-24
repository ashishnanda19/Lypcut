import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const LINES = [
  'Namaste doston, aaj hum baat karenge funding ke baare mein.',
  'Meri sabse badi galti thi ki maine bina socha paisa kharch kar diya.',
  'Term sheet par sign karne se pehle lawyer se zaroor padhwaiye.',
  'Doosri baat, apni team ko hire karte waqt dhyaan rakhiye ki log aapke vision se jude hue ho.',
  'Teesri baat, customers se roz baat kijiye, kyunki unse behtar teacher koi nahi hai.',
  'Aur aakhri baat, apne cash flow par har hafte nazar rakhiye, warna runway achanak khatam ho jaati hai.',
  'Agar yeh video pasand aaya to channel ko subscribe zaroor kijiye.',
]

/**
 * A short video with real speech, for the tests that run a file through the backend.
 * Use E2E_VIDEO to point at your own file; otherwise it is made here with macOS `say` and ffmpeg.
 * Returns null when neither is possible, so the test can say so instead of failing mysteriously.
 */
export function speechVideo(): string | null {
  if (process.env.E2E_VIDEO) return existsSync(process.env.E2E_VIDEO) ? process.env.E2E_VIDEO : null
  const dir = path.join(tmpdir(), 'lypcut-e2e')
  mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'talk.mp4')
  if (existsSync(out)) return out
  try {
    const aiff = path.join(dir, 'talk.aiff')
    // A pause after each line, so the transcript comes back as separate sentences.
    execFileSync('say', ['-v', 'Lekha', '-o', aiff, LINES.join(' [[slnc 1100]] ')])
    execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-i',
        aiff,
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        out,
      ],
      { stdio: 'ignore' },
    )
    return out
  } catch {
    return null
  }
}

/** A silent video longer than the free plan allows (10 minutes), small enough to upload instantly. */
export function longVideo(seconds = 700): string | null {
  const dir = path.join(tmpdir(), 'lypcut-e2e')
  mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `long-${seconds}.mp4`)
  if (existsSync(out)) return out
  try {
    execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:r=1',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=8000:cl=mono',
        '-t',
        String(seconds),
        '-c:v',
        'libx264',
        '-g',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '8k',
        out,
      ],
      { stdio: 'ignore' },
    )
    return out
  } catch {
    return null
  }
}
