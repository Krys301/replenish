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

This adds an hourly check: Task Scheduler on Windows, cron on macOS and Linux. Most hours it just looks and does nothing. When your weekly reset is less than 24 hours away and at least 10% of the limit is unused, it starts building.

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

## Settings

```sh
replenish config                       # show everything
replenish config stopAtPercent 90      # change one
```

| Setting | Default | Meaning |
|---|---|---|
| `windowHours` | `24` | Only start within this many hours of the weekly reset |
| `minLeftPercent` | `10` | Don't start if less than this much of the weekly limit is left |
| `stopAtPercent` | `95` | Stop when weekly **or** 5-hour usage reaches this, so you're never locked out |
| `checkIntervalSeconds` | `60` | How often usage is re-checked during a run |
| `model` | Claude Code default | e.g. `sonnet`, `opus`, `haiku` |
| `permissionMode` | `auto` | Claude Code permission mode for unattended runs |
| `projectsDir` | `~/Replenish` | Where new projects are created |
| `claudePath` | found on `PATH` | Full path to `claude`, if the scheduler can't find it |

## How it works

- **Usage:** Replenish asks your installed `claude` CLI for the same numbers `/usage` shows, without calling the model, so checking costs nothing.
- **Your login:** Replenish never touches your credentials. Everything runs through your own `claude` install and account.
- **Builds:** Claude Code runs headless in the project folder. It's told it is unattended, that it should commit after every step, and that it must never push, deploy or spend money.
- **Stopping:** usage is re-checked every minute. Replenish stops the run at your cap, or when the week resets, so the new week's limit stays yours.
- **Resuming:** a paused project continues in the same Claude session next time, and unfinished projects come before new ones.
- **When Claude says it's done:** it ends with `done`, `continue`, or `blocked`. A `blocked` project waits for you, and `REPLENISH.md` says why.

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
npm run build        # compiles to dist/
REPLENISH_HOME=/tmp/rh npm run dev -- status   # use a throwaway data folder
```
