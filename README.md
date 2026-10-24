# Lypcut

AI-native video editing for creators. Chat with an assistant, edit by transcript, get Reels-ready 9:16 exports. First-class Hindi, Hinglish and English.

This repo is the **front end**. It runs against either the in-browser mock API or the real backend in the `backend/` folder, chosen by one flag.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173, mock API (no server needed)
```

**Mock mode** (default). Sign up with any email and a password of 8 or more characters, finish onboarding, then press **Add sample projects** on the dashboard and open _Funding kaise raise karein_.

**Real mode**, against the backend:

```bash
# 1. Start the backend (Postgres, Redis, storage, API, worker). The first run downloads a speech model (~465 MB).
cd backend && docker compose up -d

# 2. Start the front end against it.
cd ..
echo "VITE_API_MODE=real" > .env.local
npm run dev          # /api and the job feed are proxied to http://localhost:4000
```

Sign up (8+ characters), drop in a video of up to 10 minutes (the free plan), and watch it process. Edits are saved to the server as you make them, so a reload brings them back. `.env.example` lists the settings (`VITE_API_MODE`, `VITE_API_PROXY`).

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Dev server                                    |
| `npm run build`     | Typecheck and production build                |
| `npm run typecheck` | `tsc -b` (strict, `noUncheckedIndexedAccess`) |
| `npm run lint`      | ESLint, including jsx-a11y                    |
| `npm test`          | Vitest unit tests                             |
| `npm run e2e`       | Playwright happy path against the mock        |
| `npm run e2e:real`  | Playwright against the real backend           |
| `npm run format`    | Prettier                                      |

The e2e test runs the whole story: sign up, onboarding, open a project, ask the assistant to remove filler words, apply, undo, export. It needs a Chromium: run `npx playwright install chromium`, or set `PW_CHROMIUM_PATH` to one you already have.

`npm run e2e:real` runs the same kind of story against the backend (start it first): sign up, upload a real video, wait for it to be transcribed, edit, undo, reload and find the edit saved, download the project file. It also covers a refreshed session, wrong passwords, signing out, and a video over the plan limit. It needs a video with speech: on macOS it makes one with `say` and `ffmpeg`; elsewhere set `E2E_VIDEO=/path/to/video.mp4`. The page's origin must be allowed by the backend's `CORS_ORIGINS` (`http://localhost:5173` by default; for another port set `E2E_PORT` and start the backend with a matching `CORS_ORIGINS`).

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

| Route                     | What it is                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- |
| `/`                       | Landing page                                                                      |
| `/login` `/signup`        | Auth                                                                              |
| `/onboarding`             | Language, content type, optional Instagram connect                                |
| `/app`                    | Dashboard (projects, drop zone)                                                   |
| `/app/new`                | Upload with progress, pause and resume (`?resume=<id>` finishes a stopped upload) |
| `/app/project/:id`        | Processing screen, or the editor once the project is ready                        |
| `/app/project/:id/export` | Export dialog over the editor                                                     |
| `/app/style`              | Style profile (Instagram connect or manual upload)                                |
| `/app/settings`           | Profile, brand kit, accounts, plan, delete data                                   |
| `/styleguide`             | Every component, working                                                          |

## How the editor works

- **One timeline model, reversible ops.** Every edit (yours or the assistant's) is a `TimelineOp` with an inverse. History, undo, redo, Edit-card previews and restore are all built on that.
- **Two time domains.** Transcript words live in source time, the timeline in timeline time. `src = item.srcIn + (t - item.start)`.
- **One clock.** `features/editor/clock.ts` drives the player, phone preview, playhead and captions. The playhead and reel crop are written straight to the DOM each frame, never through React state.
- **The assistant is a pure function.** `features/editor/planner.ts` turns a message into a plan (a list of ops) in English, Hinglish or Hindi. Swap it for a real LLM call later; the Edit cards and ops do not change.
- **Large timelines stay smooth.** The transcript and history are virtualised, and the timeline renders only the clips in view.

## Mock mode and real mode

| Area                                                | Mock                                   | Real                                                                                |
| --------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Accounts, sessions                                  | Pretend sign-in kept in `localStorage` | httpOnly cookies; the session is renewed quietly, one refresh at a time             |
| Upload                                              | A timer; the file stays in the browser | Parts go straight to storage with short-lived links; resumable; plan limits checked |
| Processing, transcript, scenes, hooks, chapters     | Scripted job and generated data        | Real transcription, scene detection and search, with live progress                  |
| The timeline and its history                        | In the browser                         | Saved on the server as you edit; undo, redo, history and restore all persist        |
| Project file (.otio)                                | Written in the browser                 | Written by the server from the saved timeline                                       |
| Video export (MP4)                                  | Simulated; downloads a stand-in clip   | Still simulated (a later phase); downloads the editing copy of your original video  |
| The assistant, Instagram connect, billing and plans | Rule-based or simulated                | Still rule-based or simulated (later phases); `/api/style/*` stays mocked           |
| "Add sample projects", Google sign-in               | Available                              | Hidden (not part of the real product yet)                                           |

Mock data is stored in `localStorage` (`lypcut-mock-db-v1`). Clear it to reset.

### How edits reach the server

Every change is applied in the editor at once, then sent to the server in order, each with the version it was based on. The server checks it and its answer is adopted. Clips that an edit creates get the same ids on both sides (`i_v<version>_<n>`), so a second edit can name them before the first has been saved. If a save fails or the project was changed in another tab, the editor reloads the saved version and says so; the top bar shows _Saving…_, _Saved_ or _Not saved_. Code: `features/editor/sync.ts`, with `lib/timeline/ops.ts` shared in behaviour with the server's engine (`npm run parity` in the backend compares them on random edits).

## Open decisions

- Assistant name: Kaat or Koodo (`src/lib/config.ts`).
- Final logo and typeface (current ones are placeholders).

# Lypcut
