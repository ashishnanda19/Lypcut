# Lypcut

AI-native video editing for creators. Chat with an assistant, edit by transcript, get Reels-ready 9:16 exports. First-class Hindi, Hinglish and English.

This repo is the **front end only**, built against a typed mock API (MSW). There is no backend yet.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

The mock API starts with the app. Sign up with any email and a 6+ character password, finish onboarding, then press **Add sample projects** on the dashboard and open _Funding kaise raise karein_.

```bash

```

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Dev server                                    |
| `npm run build`     | Typecheck and production build                |
| `npm run typecheck` | `tsc -b` (strict, `noUncheckedIndexedAccess`) |
| `npm run lint`      | ESLint, including jsx-a11y                    |
| `npm test`          | Vitest unit tests                             |
| `npm run e2e`       | Playwright happy path (see below)             |
| `npm run format`    | Prettier                                      |

The e2e test runs the whole story: sign up, onboarding, open a project, ask the assistant to remove filler words, apply, undo, export. It needs a Chromium: run `npx playwright install chromium`, or set `PW_CHROMIUM_PATH` to one you already have.

## Stack

React 18, TypeScript (strict), Vite, Tailwind v4, Radix primitives, lucide-react, Framer Motion, Zustand, TanStack Query, React Router, MSW, Vitest, Playwright.

## Layout

```
src/
  app/                 providers and routes (all routes lazy-loaded)
  components/
    brand/             Logo, AiMark, CutLine, LeapLoader
    ui/                Button, Input, Select, Tabs, Dialog, Sheet, Tooltip, Toast, ...
    domain/            ClipCard, EditCard, ChatMessage, PromptBox, TranscriptWord,
                       TimelineTrack/Clip/Ruler, Playhead, PhoneFrame, MetricChip, ...
  features/
    landing/ auth/ dashboard/ upload/ project/   public site, sign-in, project list, upload, processing
    editor/            the editor: store, planner (mock LLM), timeline, transcript, chat, search,
                       clips, history, live phone preview, shortcuts
    export/ style/ settings/                      export dialog, style profile, settings
  lib/                 cn, time, motion, theme, config, useStreamedText
  pages/styleguide/    /styleguide: every component, working
  styles/index.css     design tokens, theme, signature motion
```

Import with `@/`, for example `import { Button } from '@/components/ui/Button'`.

## Design tokens

Defined as CSS variables in `src/styles/index.css`, with a dark default and a `[data-theme="light"]` override.

- **Ink** surfaces (`--bg`, `--surface-1..3`), **saffron** accent, **teal** secondary.
- **Coral is reserved for the cut-line.** If you see coral, something was cut there.
- Motion is under 300ms and respects `prefers-reduced-motion`. The signature is the **leap**: a short arc up, a squash on landing, a settle (`.leap`, `leap` variants in `lib/motion.ts`).
- Type: Inter (optical-size axis) for UI, Noto Sans Devanagari for Hindi. Timecodes use `.tnum`.

## Brand placeholders

The assistant's name lives in `src/lib/config.ts` (`AI.name`). Two options were proposed, **Kaat** (काट, "cut") and **Koodo** (कूद, "jump"). Kaat is the placeholder until chosen.

## Routes

| Route                     | What it is                                                 |
| ------------------------- | ---------------------------------------------------------- |
| `/`                       | Landing page                                               |
| `/login` `/signup`        | Auth (mock)                                                |
| `/onboarding`             | Language, content type, optional Instagram connect         |
| `/app`                    | Dashboard (projects, drop zone)                            |
| `/app/new`                | Upload with progress, pause and resume                     |
| `/app/project/:id`        | Processing screen, or the editor once the project is ready |
| `/app/project/:id/export` | Export dialog over the editor                              |
| `/app/style`              | Style profile (Instagram connect or manual upload)         |
| `/app/settings`           | Profile, brand kit, accounts, plan, delete data            |
| `/styleguide`             | Every component, working                                   |

## How the editor works

- **One timeline model, reversible ops.** Every edit (yours or the assistant's) is a `TimelineOp` with an inverse. History, undo, redo, Edit-card previews and restore are all built on that.
- **Two time domains.** Transcript words live in source time, the timeline in timeline time. `src = item.srcIn + (t - item.start)`.
- **One clock.** `features/editor/clock.ts` drives the player, phone preview, playhead and captions. The playhead and reel crop are written straight to the DOM each frame, never through React state.
- **The assistant is a pure function.** `features/editor/planner.ts` turns a message into a plan (a list of ops) in English, Hinglish or Hindi. Swap it for a real LLM call later; the Edit cards and ops do not change.
- **Large timelines stay smooth.** The transcript and history are virtualised, and the timeline renders only the clips in view.

## What is mocked

- Uploading (a timer; your file stays in the browser) and processing (a scripted job stream over a mock socket). A job id containing `fail` fails at Transcribing until retried.
- Transcript, scenes, hooks, chapters and Reel metrics: generated, deterministic data. Video is a 20-second stand-in clip.
- The assistant: rule-based, not an LLM.
- Instagram connect, billing and plans: simulated.
- Export: progress is simulated and the MP4 you download is the stand-in clip. The **.otio project file is real** and reflects your edit.
- Data is stored in `localStorage` (`lypcut-mock-db-v1`). Clear it to reset.

## Open decisions

- Assistant name: Kaat or Koodo (`src/lib/config.ts`).
- Final logo and typeface (current ones are placeholders).
# Lypcut
