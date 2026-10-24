import { describe, expect, it } from 'vitest'
import {
  buildScenes,
  parseSceneMetadata,
  parseSilences,
  sceneLabel,
  type Cut,
} from '../../src/media/scenes.js'
import { parseKeyframes, onKeyframe } from '../../src/media/transform.js'

const covers = (scenes: Array<{ start: number; end: number }>, duration: number) => {
  expect(scenes[0]!.start).toBe(0)
  expect(scenes[scenes.length - 1]!.end).toBe(duration)
  for (let i = 1; i < scenes.length; i++) expect(scenes[i]!.start).toBe(scenes[i - 1]!.end)
  for (const s of scenes) expect(s.end).toBeGreaterThan(s.start)
}

describe('parsing FFmpeg output', () => {
  it('reads scene cuts from metadata=print', () => {
    const text = [
      'frame:30   pts:30      pts_time:3',
      'lavfi.scene_score=0.912345',
      'frame:70   pts:70      pts_time:7.1',
      'lavfi.scene_score=0.55',
    ].join('\n')
    expect(parseSceneMetadata(text)).toEqual([
      { time: 3, score: 0.912345 },
      { time: 7.1, score: 0.55 },
    ])
  })

  it('reads silences from silencedetect', () => {
    const text = [
      '[silencedetect @ 0x1] silence_start: 3.0015',
      '[silencedetect @ 0x1] silence_end: 5.0021 | silence_duration: 2.0006',
      '[silencedetect @ 0x1] silence_start: 9',
    ].join('\n')
    // An unfinished silence at the very end has no end yet, so it is not reported.
    expect(parseSilences(text)).toEqual([{ start: 3.0015, end: 5.0021 }])
  })

  it('clamps a silence that FFmpeg reports as starting before zero', () => {
    expect(parseSilences('silence_start: -0.02\nsilence_end: 1.5')[0]!.start).toBe(0)
  })

  it('reads keyframes from packet flags', () => {
    expect(parseKeyframes('0.000000,K__\n0.100000,___\n1.000000,K__\nN/A,K__\n')).toEqual([0, 1])
  })

  it('tells whether a time is on a keyframe', () => {
    const keys = [0, 2, 4, 6]
    expect(onKeyframe(keys, 0)).toBe(true)
    expect(onKeyframe(keys, 4.02)).toBe(true)
    expect(onKeyframe(keys, 3)).toBe(false)
    expect(onKeyframe(keys, 5.9)).toBe(false)
  })
})

describe('buildScenes', () => {
  const cut = (time: number, score = 0.8): Cut => ({ time, score })

  it('covers the whole video with no gaps or overlaps', () => {
    const scenes = buildScenes([cut(10), cut(25), cut(40)], 60, [])
    expect(scenes.map((s) => [s.start, s.end])).toEqual([
      [0, 10],
      [10, 25],
      [25, 40],
      [40, 60],
    ])
    covers(scenes, 60)
  })

  it('a video with no cuts is one scene', () => {
    expect(buildScenes([], 30, [])).toEqual([{ start: 0, end: 30, score: null }])
  })

  it('records the score of the cut that opened each scene', () => {
    const scenes = buildScenes([cut(10, 0.9)], 20, [])
    expect(scenes.map((s) => s.score)).toEqual([null, 0.9])
  })

  it('folds cuts that are too close together into one', () => {
    const scenes = buildScenes([cut(10), cut(10.4), cut(11)], 30, [], { minSceneSec: 1.5 })
    expect(scenes.map((s) => s.start)).toEqual([0, 10])
    covers(scenes, 30)
  })

  it('ignores a cut right at the start or end', () => {
    const scenes = buildScenes([cut(0.3), cut(29.5)], 30, [])
    expect(scenes).toHaveLength(1)
  })

  it('handles unsorted cuts', () => {
    const scenes = buildScenes([cut(20), cut(5)], 30, [])
    expect(scenes.map((s) => s.start)).toEqual([0, 5, 20])
  })

  describe('a long unbroken shot (a talking head)', () => {
    it('is split into pieces no longer than the maximum', () => {
      const scenes = buildScenes([], 300, [], { maxSceneSec: 60 })
      expect(scenes).toHaveLength(5)
      for (const s of scenes) expect(s.end - s.start).toBeLessThanOrEqual(60 + 1e-9)
      covers(scenes, 300)
    })

    it('splits at the middle of a nearby pause when there is one', () => {
      // Ideal split at 60; there is a pause centred on 57.
      const scenes = buildScenes([], 120, [{ start: 56, end: 58 }], { maxSceneSec: 60 })
      expect(scenes).toHaveLength(2)
      expect(scenes[0]!.end).toBe(57)
    })

    it('ignores a pause that is too far from the ideal point', () => {
      const scenes = buildScenes([], 120, [{ start: 5, end: 6 }], { maxSceneSec: 60 })
      expect(scenes[0]!.end).toBe(60)
    })

    it('keeps the opening cut’s score on the first piece only', () => {
      const scenes = buildScenes([cut(10, 0.7)], 200, [], { maxSceneSec: 60 })
      const second = scenes.filter((s) => s.start >= 10)
      expect(second[0]!.score).toBe(0.7)
      expect(second.slice(1).every((s) => s.score === null)).toBe(true)
    })

    it('never produces a sliver', () => {
      for (const duration of [61, 100, 119, 121, 599, 3 * 3600]) {
        const scenes = buildScenes([], duration, [], { maxSceneSec: 60 })
        covers(scenes, duration)
        for (const s of scenes) expect(s.end - s.start).toBeGreaterThanOrEqual(1.5)
      }
    })
  })

  it('names scenes for people', () => {
    expect(sceneLabel(0)).toBe('Scene 1')
    expect(sceneLabel(11)).toBe('Scene 12')
  })
})
