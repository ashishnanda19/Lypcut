import type { Job, Project, ReelMetric, StyleProfile } from '@/types'
import { generateSource, type GeneratedSource } from './data/seed'

/**
 * The mock backend's "database". Lives in memory and mirrors the project list to localStorage,
 * so a refresh keeps what you uploaded. Swap this whole folder for real endpoints later:
 * the client only ever talks to /api/* and the jobs socket.
 */

interface SeedSpec {
  offset: number
  count: number
}

export interface DbProject extends Project {
  seed: SeedSpec
}

const STORAGE_KEY = 'lypcut-mock-db-v1'
export const DEMO_VIDEO_URL = '/demo/proxy.mp4'

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function sample(
  id: string,
  title: string,
  status: Project['status'],
  seed: SeedSpec,
  agoMin: number,
  extra: Partial<Project> = {},
): DbProject {
  const src = generateSource(id, seed.offset, seed.count)
  return {
    id,
    title,
    status,
    durationSec: src.duration,
    language: 'hinglish',
    thumbSeed: id,
    createdAt: minutesAgo(agoMin + 30),
    updatedAt: minutesAgo(agoMin),
    hooksFound: src.highlights.length,
    assets: [
      { id: `${id}_raw`, kind: 'raw', label: 'Original upload', durationSec: src.duration },
      {
        id: `${id}_proxy`,
        kind: 'proxy',
        label: 'Editing proxy (360p)',
        durationSec: src.duration,
        url: DEMO_VIDEO_URL,
      },
    ],
    seed,
    ...extra,
  }
}

export function sampleProjects(): DbProject[] {
  return [
    sample('p_funding', 'Funding kaise raise karein, Ep 42', 'ready', { offset: 0, count: 56 }, 95),
    sample('p_mistakes', 'Startup ki 5 galtiyan', 'ready', { offset: 8, count: 44 }, 60 * 26),
    sample(
      'p_hiring',
      'Podcast clip: hiring ka sach',
      'exported',
      { offset: 28, count: 36 },
      60 * 24 * 3,
    ),
    sample('p_live', 'Live Q&A: investors ke sawaal', 'processing', { offset: 14, count: 60 }, 12, {
      progress: 58,
      jobId: 'job_live',
      hooksFound: undefined,
    }),
    sample('p_vlog', 'Founder vlog #12', 'uploading', { offset: 30, count: 40 }, 4, {
      progress: 34,
      hooksFound: undefined,
    }),
    sample('p_demo', 'Product demo walkthrough', 'failed', { offset: 20, count: 32 }, 60 * 40, {
      jobId: 'job_fail_demo',
      hooksFound: undefined,
    }),
  ]
}

function load(): DbProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { projects: DbProject[] }
      if (Array.isArray(parsed.projects)) return parsed.projects
    }
  } catch {
    /* storage unavailable: start from samples */
  }
  return sampleProjects()
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ projects: db.projects }))
  } catch {
    /* ignore */
  }
}

export const db = {
  projects: load(),
  jobs: new Map<string, Job>(),
  sources: new Map<string, GeneratedSource>(),
  style: { connected: false, source: null } as {
    connected: boolean
    source: 'instagram' | 'upload' | null
    reels: number
  },
}
db.style.reels = 0

export function saveProjects() {
  persist()
}

export function resetToSamples() {
  db.projects = sampleProjects()
  db.sources.clear()
  persist()
}

export function addSamples() {
  const have = new Set(db.projects.map((p) => p.id))
  db.projects = [...sampleProjects().filter((p) => !have.has(p.id)), ...db.projects]
  persist()
}

export function clearProjects() {
  db.projects = []
  db.sources.clear()
  persist()
}

export function findProject(id: string): DbProject | undefined {
  return db.projects.find((p) => p.id === id)
}

export function getSource(id: string): GeneratedSource | undefined {
  const cached = db.sources.get(id)
  if (cached) return cached
  const p = findProject(id)
  if (!p) return undefined
  const src = generateSource(p.id, p.seed.offset, p.seed.count)
  db.sources.set(id, src)
  return src
}

export function publicProject(p: DbProject): Project {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seed: _seed, ...rest } = p
  return rest
}

/* ------------------------------------------------------------------ */
/* Instagram style data                                                  */
/* ------------------------------------------------------------------ */

export const REELS: ReelMetric[] = [
  {
    id: 'r1',
    title: 'The ₹40 lakh mistake',
    thumbSeed: 'reel-1',
    views: 482_000,
    likes: 31_200,
    saves: 9_800,
    shares: 6_400,
    avgWatchPct: 74,
    durationSec: 31,
    postedAt: minutesAgo(60 * 24 * 6),
  },
  {
    id: 'r2',
    title: 'Pitch deck: 10 slides',
    thumbSeed: 'reel-2',
    views: 312_000,
    likes: 22_100,
    saves: 14_300,
    shares: 4_100,
    avgWatchPct: 68,
    durationSec: 28,
    postedAt: minutesAgo(60 * 24 * 13),
  },
  {
    id: 'r3',
    title: 'Payroll wali raat',
    thumbSeed: 'reel-3',
    views: 268_000,
    likes: 25_900,
    saves: 5_200,
    shares: 7_800,
    avgWatchPct: 81,
    durationSec: 24,
    postedAt: minutesAgo(60 * 24 * 20),
  },
  {
    id: 'r4',
    title: 'Valuation ek kahani hai',
    thumbSeed: 'reel-4',
    views: 154_000,
    likes: 9_800,
    saves: 3_900,
    shares: 1_900,
    avgWatchPct: 59,
    durationSec: 38,
    postedAt: minutesAgo(60 * 24 * 27),
  },
  {
    id: 'r5',
    title: 'Cold email jo kaam kiya',
    thumbSeed: 'reel-5',
    views: 121_000,
    likes: 8_400,
    saves: 6_100,
    shares: 1_200,
    avgWatchPct: 63,
    durationSec: 33,
    postedAt: minutesAgo(60 * 24 * 34),
  },
  {
    id: 'r6',
    title: 'Pehle 10 hires',
    thumbSeed: 'reel-6',
    views: 96_000,
    likes: 6_100,
    saves: 2_300,
    shares: 800,
    avgWatchPct: 52,
    durationSec: 45,
    postedAt: minutesAgo(60 * 24 * 41),
  },
  {
    id: 'r7',
    title: 'Term sheet ki raat',
    thumbSeed: 'reel-7',
    views: 88_000,
    likes: 7_700,
    saves: 1_800,
    shares: 2_100,
    avgWatchPct: 77,
    durationSec: 22,
    postedAt: minutesAgo(60 * 24 * 48),
  },
  {
    id: 'r8',
    title: 'Bootstrapping ya funding?',
    thumbSeed: 'reel-8',
    views: 64_000,
    likes: 3_900,
    saves: 1_400,
    shares: 600,
    avgWatchPct: 47,
    durationSec: 52,
    postedAt: minutesAgo(60 * 24 * 55),
  },
]

export function styleProfile(): StyleProfile {
  if (!db.style.connected) {
    return {
      connected: false,
      source: null,
      reelsAnalysed: 0,
      hookTimingSec: 0,
      cutPace: 0,
      captionStyles: [],
      music: [],
      hookRetention: [],
      fonts: [],
      colors: [],
    }
  }
  const upload = db.style.source === 'upload'
  return {
    connected: true,
    source: db.style.source,
    ...(upload ? {} : { handle: '@aarav.builds' }),
    reelsAnalysed: upload ? db.style.reels : 24,
    hookTimingSec: 1.6,
    cutPace: 3.4,
    captionStyles: [
      { id: 'saffron-pop', share: 0.46 },
      { id: 'boxed', share: 0.28 },
      { id: 'karaoke', share: 0.18 },
      { id: 'minimal', share: 0.08 },
    ],
    music: [
      { label: 'Lo-fi beats', share: 0.38 },
      { label: 'Trending audio', share: 0.34 },
      { label: 'Upbeat pop', share: 0.18 },
      { label: 'No music', share: 0.1 },
    ],
    hookRetention: [71, 66, 78, 62, 69, 74, 81, 77],
    fonts: ['Inter', 'Noto Sans Devanagari'],
    colors: ['#ffa83a', '#5fcdbb', '#f4efe6'],
  }
}
