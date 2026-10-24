import { run, type RunOptions } from './ffmpeg.js'

/** A moment where the picture changes sharply, and how sharply (0-1). */
export interface Cut {
  time: number
  score: number
}

export interface SceneRange {
  start: number
  end: number
  /** Scene-change score of the cut that opened this scene. Null for the first scene or a time-based split. */
  score: number | null
}

export interface Silence {
  start: number
  end: number
}

/**
 * Finds picture cuts. Frames are sampled at 10 per second and shrunk first, which is far cheaper than
 * decoding every frame at full size and loses nothing a cut detector needs.
 */
export async function detectCuts(
  input: string,
  opts: RunOptions & { threshold?: number } = {},
): Promise<Cut[]> {
  const threshold = opts.threshold ?? 0.3
  const { stdout } = await run(
    [
      '-i',
      input,
      '-an',
      '-vf',
      `fps=10,scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
      '-f',
      'null',
      '-',
    ],
    { ...opts, collectStdout: true },
  )
  return parseSceneMetadata(stdout)
}

/**
 * Parses the `metadata=print` output: a "frame:… pts_time:T" line followed by "lavfi.scene_score=S".
 */
export function parseSceneMetadata(text: string): Cut[] {
  const cuts: Cut[] = []
  let time: number | null = null
  for (const line of text.split('\n')) {
    const t = /pts_time:([\d.]+)/.exec(line)
    if (t) time = Number(t[1])
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line)
    if (s && time !== null) {
      cuts.push({ time, score: Number(s[1]) })
      time = null
    }
  }
  return cuts
}

/** Quiet stretches, from FFmpeg's silencedetect. */
export async function detectSilences(
  input: string,
  opts: RunOptions & { noiseDb?: number; minSec?: number } = {},
): Promise<Silence[]> {
  const { stderr } = await run(
    [
      '-i',
      input,
      '-vn',
      '-af',
      `silencedetect=noise=${opts.noiseDb ?? -35}dB:d=${opts.minSec ?? 0.6}`,
      '-f',
      'null',
      '-',
    ],
    opts,
  )
  return parseSilences(stderr)
}

export function parseSilences(text: string): Silence[] {
  const out: Silence[] = []
  let start: number | null = null
  for (const line of text.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) start = Math.max(0, Number(s[1]))
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (e && start !== null) {
      const end = Number(e[1])
      if (end > start) out.push({ start, end })
      start = null
    }
  }
  return out
}

export interface SceneOptions {
  /** Cuts closer than this to the previous one are folded into it. */
  minSceneSec?: number
  /** A scene longer than this is split further (at a pause if there is one). */
  maxSceneSec?: number
}

/**
 * Turns cuts into scenes that cover the whole video with no gaps or overlaps. Then splits any scene
 * that is too long (a talking head with no picture cuts would otherwise be one 10 minute clip), at the
 * quietest convenient moment: a pause near the ideal split point, else the point itself.
 */
export function buildScenes(
  cuts: Cut[],
  duration: number,
  silences: Silence[],
  opts: SceneOptions = {},
): SceneRange[] {
  const minScene = opts.minSceneSec ?? 1.5
  const maxScene = opts.maxSceneSec ?? 60

  const bounds: Array<{ time: number; score: number | null }> = [{ time: 0, score: null }]
  for (const cut of [...cuts].sort((a, b) => a.time - b.time)) {
    const last = bounds[bounds.length - 1]!
    // Too close to the previous cut, or to the very end: not a scene of its own.
    if (cut.time - last.time < minScene || duration - cut.time < minScene) continue
    bounds.push({ time: cut.time, score: cut.score })
  }

  const scenes: SceneRange[] = bounds.map((b, i) => ({
    start: b.time,
    end: bounds[i + 1]?.time ?? duration,
    score: b.score,
  }))
  return scenes.flatMap((s) => splitLong(s, silences, maxScene, minScene))
}

function splitLong(
  scene: SceneRange,
  silences: Silence[],
  maxScene: number,
  minScene: number,
): SceneRange[] {
  const length = scene.end - scene.start
  if (length <= maxScene) return [scene]

  const pieces = Math.ceil(length / maxScene)
  const target = length / pieces
  const splits: number[] = []
  let prev = scene.start
  for (let i = 1; i < pieces; i++) {
    const ideal = scene.start + target * i
    // Prefer the middle of a pause within a third of a piece of the ideal point.
    const window = target / 3
    const nearby = silences
      .map((s) => (s.start + s.end) / 2)
      .filter(
        (m) => Math.abs(m - ideal) <= window && m - prev >= minScene && scene.end - m >= minScene,
      )
      .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0]
    const at = nearby ?? ideal
    splits.push(at)
    prev = at
  }

  const edges = [scene.start, ...splits, scene.end]
  return edges.slice(0, -1).map((start, i) => ({
    start,
    end: edges[i + 1]!,
    score: i === 0 ? scene.score : null,
  }))
}

/** "Scene 1", "Scene 2"... Real titles are a later, assistant-phase feature. */
export const sceneLabel = (index: number): string => `Scene ${index + 1}`
