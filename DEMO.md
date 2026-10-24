# A three-minute demo

What it shows: you edit a video by talking to it, in Hindi, Hinglish or English, and nothing is applied until you say so.

## Before you start (five minutes, once)

```bash
cd backend && docker compose up -d          # first run downloads the speech and search models
cd ../frontend && echo "VITE_API_MODE=real" > .env.local && npm install && npm run dev
```

Open http://localhost:5173, sign up, and **upload a talking-head video of 5 to 10 minutes in Hindi or Hinglish.** Processing runs
on your machine and takes a few minutes, so do this before the demo and leave the finished project open. No API key is needed:
without one the assistant runs on the built-in offline model. With `ANTHROPIC_API_KEY` set, the same script runs on Claude and
understands looser phrasing.

## The script

| Time | You say or do                                                                   | What the audience sees                                                                   | Say                                                                           |
| ---- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0:00 | Open the finished project, click the **Clips** tab                              | A ranked list of hooks, each with a score, found automatically while the video processed | "I did not mark any of these. It found the moments worth turning into Reels." |
| 0:25 | Type **`ek Reel banao`**                                                        | The assistant asks three questions as tappable cards: which part, how long, what pace    | "Notice it asks instead of guessing. It never invents a time."                |
| 0:50 | Tap **My best hook**, a length (say **Most popular**), then **Fast and punchy** | An Edit card: a before/after strip, how much is cut, the hook score                      | "That is a plan, not an edit. Nothing has changed yet."                       |
| 1:15 | Click **Preview**                                                               | The player shows the Reel; the timeline shows the cuts; History is unchanged             | "I can look at it before I commit."                                           |
| 1:30 | Click **Apply**, then **Undo**                                                  | The edit lands with a short animation; undo puts it back exactly                         | "Every change is one reversible step, labelled as the assistant's."           |
| 1:50 | Open **History**                                                                | The assistant's version, marked as AI, next to yours                                     | "I can always see who changed what, and go back."                             |
| 2:05 | Type **`filler words hatao`**                                                   | A card with the count of fillers and the seconds saved; apply it                         | "Same thing in Hinglish. Hindi in Devanagari works too."                      |
| 2:25 | Open **Search**, type **`where I talk about my biggest mistake`**               | The moment, with a thumbnail and time, even though those words are not in the video      | "This finds meaning, not just words: English finds Hindi."                    |
| 2:45 | Type **`add some music`**                                                       | A polite no, with the reason                                                             | "It never adds music. You bring your own after export."                       |
| 2:55 | Say the closing line                                                            |                                                                                          | "Everything it does is an edit I can see, preview, and undo."                 |

## If something goes wrong

- **The assistant says it could not reach the service:** the backend is not running (`docker compose ps` in `backend/`).
- **"You have used today's assistant requests":** the daily allowance is 30 on the free plan when a real model is configured. The
  offline model is not counted. Change `PLANNER_DAILY_LIMIT` in `backend/.env`.
- **Search finds nothing for a loose phrase:** the offline search by meaning is a small model; try a phrase close to what was said, or
  use Claude and a longer video.
- **The Clips tab is empty:** a video shorter than about 15 seconds has no hook-sized stretch.
