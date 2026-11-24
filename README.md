<img src="assets/icon.svg" width="64" height="64" alt="">

# Replenish

**Your AI plan resets every week, and the unused part disappears.** Replenish spends the leftover usage on the projects you saved but never got around to building.

You keep a queue of ideas. In the last day before your weekly limit resets, if there's usage left, Replenish starts Claude Code on your next idea. It builds the idea in its own folder and commits as it goes. It stops before you hit the limit, picks up where it left off the following week, and writes you a report.

```
$ replenish status
Plan: pro
Weekly   ██████░░░░░░░░░░░░░░ 31% used, resets in 14.2h
5-hour   █░░░░░░░░░░░░░░░░░░░ 4% used, resets in 4.9h

69% of the weekly limit is unused and it resets in 14.2h.
Next up: Habit tracker PWA (habit-tracker-pwa)
```

## Requirements

- [Node.js](https://nodejs.org) 22.18 or newer
- [Claude Code](https://claude.com/claude-code) installed and logged in with a **Pro or Max** plan (run `claude` once and sign in)
- git

Works on Windows, macOS and Linux.

## Install

```sh
npm install -g github:Krys301/replenish
replenish help
```

Or from a clone:

```sh
git clone https://github.com/Krys301/replenish.git
cd replenish
npm install
npm link        # makes the `replenish` command available everywhere
```

## How to use it

### 1. Check that it can see your usage

```sh
replenish status
```

You should see your plan, your weekly and 5-hour bars, and whether Replenish would start right now. Checking usage costs nothing.

### 2. Queue the things you never got around to building

```sh
replenish add "A habit tracker PWA: daily habits, streaks, reminders, works offline. React + Vite." --priority 1
replenish add "Script that renames photos in a folder by their EXIF date" --name "Photo renamer"
replenish add --file ideas/recipe-app.md --name "Recipe app"
```

- **The more detail, the better the result.** Say what it is, who it's for, the key features, and any tech you prefer. Claude works alone, so it can't ask you follow-up questions.
- `--priority 1` runs first. The default is 3.
- `--repo <path>` works inside one of your existing repos instead of a new folder. It goes on a separate `replenish/<id>` branch in its own git worktree, so your checkout is never touched.

```sh
replenish list
→ habit-tracker-pwa            P1  queued      0 run(s)
  photo-renamer                P3  queued      0 run(s)
```

### 3. Turn it on

```sh
replenish install
```

This adds an hourly check: Task Scheduler on Windows, cron on macOS and Linux. Each check records your usage, which is how Replenish learns your pace. When it forecasts that part of your limit will go unused, it starts building (see [When does it start?](#when-does-it-start)).

## When does it start?

Replenish watches how **you** use Claude and only spends what you aren't going to use.

1. **It learns your pace, hour by hour.** Every hourly check records your weekly usage. From the last 14 days it works out how much you normally use **at each hour of the day**. Replenish's own runs are left out, so it never mistakes its own work for yours.
2. **It forecasts the reset.** It adds up what you usually use in each hour left before the reset. If the reset is overnight, it reserves almost nothing for those hours. A flat daily average would hold back usage you were never going to use.
3. **It keeps a reserve for you** of what you're expected to need before the reset, times a safety margin (`safetyFactor`, 1.5×). Everything above the reserve is spare:

   ```
   ceiling = stopAtPercent − (your expected usage until reset × safetyFactor)
   ```

4. **It builds with the spare.** If the spare is at least `minLeftPercent` (10%), Replenish starts the next project and stops when usage reaches the ceiling. The reserve shrinks as the reset gets closer, so the ceiling rises, reaching `stopAtPercent` (95%) at the reset.

So a light user gets projects built from mid-week. A heavy user only gets the bit left over at the end, or nothing.

```
$ replenish status
Weekly   ██░░░░░░░░░░░░░░░░░░ 9% used, resets in 63.1h

Your pace  ~2.4% of the weekly limit per day (from 48h of history)
Forecast   ~15% used by reset if Replenish does nothing
Spare now  77% (Replenish may go up to 86% now, rising to 95% at reset)
```

See your own pattern with `replenish analyze`:

```
  12:00  █████████████████              0.25%/h
  14:00  ██████████████████████████████ 0.45%/h
  17:00                                 0.00%/h
Average: 2.2% of your weekly limit per day.
Your quiet hours: 17-9. To have Replenish build only then: replenish config activeHours auto
```

**It also won't:**
- start while you're using Claude yourself (`skipIfUserActive`)
- run outside the hours you choose (`activeHours`: `22-7` for overnight, or `auto` for your learned quiet hours)
- go past `stopAtPercent` on the weekly **or** 5-hour limit
- touch your next week: if the limit resets mid-run, it stops

**It also won't waste a 5-hour window.** If the 5-hour limit runs out but weekly spare remains and the window resets within 90 minutes, Replenish waits and carries on. Without this, the hourly check would lose up to an hour of every window.

**While it's learning** (the first 24 hours of history), it uses a simple rule: spend what's left in the last `windowHours` (24h) before the reset. If you always want that rule, use `replenish config strategy deadline`.

### 4. See what it built

- **Projects:** `~/Replenish/<project-id>/`. Each one is a git repo with a `REPLENISH.md` explaining what was built, the decisions Claude made, how to run it, and the next steps.
- **Reports:** `~/.replenish/reports/`, one per run, with what changed, why it stopped, usage before and after, and the commits.
- **Log:** `~/.replenish/replenish.log`

```sh
replenish list        # done / in_progress / blocked
replenish requeue <id>   # send a finished or blocked project back for more work
replenish remove <id>
```

### Don't want to wait for the reset?

```sh
replenish run              # start the next project now
replenish run photo-renamer
replenish tick --dry-run   # show what the hourly check would do
```

`run` still stops at the usage cap.

### Stop everything right now

```sh
replenish pause    # kill switch: nothing starts, and a running build stops within a minute
replenish resume
```

## Settings

```sh
replenish config                       # show everything
replenish config stopAtPercent 90      # change one
```

| Setting | Default | Meaning |
|---|---|---|
| `strategy` | `pace` | `pace`: forecast your usage and spend the spare any time. `deadline`: only spend what's left in the last `windowHours` before the reset |
| `safetyFactor` | `1.5` | Pace mode: keep this many times your expected remaining usage in reserve |
| `windowHours` | `24` | Deadline mode (and the fallback while learning): start within this many hours of the reset |
| `minLeftPercent` | `10` | Don't start unless at least this much of the weekly limit is spare |
| `stopAtPercent` | `95` | Never let weekly **or** 5-hour usage go past this, so you're never locked out |
| `activeHours` | any time | Only run in these local hours, e.g. `22-7` for overnight, or `auto` for your learned quiet hours |
| `maxRunMinutes` | `180` | Watchdog: force-stop a single Claude session that runs longer than this (it resumes next time) |
| `skipIfUserActive` | `true` | Don't start while you're using Claude yourself |
| `checkIntervalSeconds` | `60` | How often usage is re-checked during a run |
| `model` | Claude Code default | e.g. `sonnet`, `opus`, `haiku` |
| `permissionMode` | `auto` | Claude Code permission mode for unattended runs |
| `projectsDir` | `~/Replenish` | Where new projects are created |
| `claudePath` | found on `PATH` | Full path to `claude`, if the scheduler can't find it |

## How it works

- **Usage:** Replenish asks your installed `claude` CLI for the same numbers `/usage` shows, without calling the model, so checking costs nothing.
- **Your login:** Replenish never touches your credentials. Everything runs through your own `claude` install and account.
- **Builds:** Claude Code runs headless in the project folder. It's told it is unattended, that it should commit after every step, and that it must never push, deploy or spend money.
- **Stopping:** usage is re-checked every minute. Replenish stops the run when it reaches the pace ceiling or your cap, when your active hours end, or when the week resets, so the new week stays yours.
- **Resuming:** a paused project continues in the same Claude session next time, and unfinished projects come before new ones.
- **When Claude says it's done:** it ends with `done`, `continue`, or `blocked`. A `blocked` project waits for you, and `REPLENISH.md` says why.

## Safety

An unattended loop that starts Claude sessions can go wrong fast. One known failure mode is a hook that starts `claude -p` and chains into hundreds of sessions, using up a whole 5-hour window. Replenish has these guards:

| Guard | What it stops |
|---|---|
| **Kill switch:** `replenish pause` | Nothing starts, and a running build stops within a minute. `replenish resume` re-enables it. |
| **Hooks off in builds** | Build sessions run with `disableAllHooks`, so your SessionEnd or other hooks can't fire on every round or start more sessions. |
| **No recursion** | Every build session is marked as started by Replenish. If anything inside it runs `replenish`, Replenish refuses. |
| **One run at a time** | A lock file. A crashed run's stale lock is detected and cleared. |
| **Usage-aware stopping** | Live usage is checked every minute against the pace ceiling and `stopAtPercent`. |
| **Never runs blind** | If usage can't be read 3 times in a row, the build stops. |
| **Watchdog** | A session running longer than `maxRunMinutes` is interrupted, and killed if it ignores the interrupt. |
| **Bounded rounds** | At most 10 rounds per run, and 3 failed runs in a row mark a project `failed`. |
| **Sandboxed work** | Builds happen in their own folder or worktree branch. They never push, deploy, or spend money. |

## Uninstall

```sh
replenish uninstall      # removes the hourly task
npm uninstall -g replenish
```

Your projects in `~/Replenish` and data in `~/.replenish` are left alone. Delete them if you want.

## Things to know

- Replenish reads usage through a Claude Code interface that isn't officially documented. A Claude Code update could break it. If `replenish status` stops working, please open an issue.
- Use it within your plan's terms. Replenish only automates *your own* Claude Code on *your own* account.
- Your computer needs to be awake near the reset for the hourly check to run.

## Roadmap

- More providers: OpenAI Codex, Gemini CLI. `src/providers/types.ts` is the plug-in point.
- Desktop notifications and a summary page
- `replenish add --interactive`: Claude interviews you to turn a one-liner into a solid brief
- launchd on macOS

## Development

```sh
npm install
npm test             # runs the TypeScript tests directly with node --test
npm run typecheck
npm run build        # compiles to dist/ (committed: run this before committing src/ changes)
REPLENISH_HOME=/tmp/rh npm run dev -- status   # use a throwaway data folder
```
