<img src="assets/icon.svg" width="64" height="64" alt="">

# Replenish

**Your Claude plan resets every week, and whatever you didn't use is gone.** Replenish spends that leftover usage on the projects you saved but never got around to building.

You keep a queue of project ideas. Replenish watches how much of your weekly limit you normally use. When it can see that some of it will go unused before the reset, it starts Claude Code on your next idea and lets it build on its own. It commits as it goes, stops before you get anywhere near your limit, and tells you where the finished project is.

```
$ replenish status
Plan: max
Weekly   ██░░░░░░░░░░░░░░░░░░ 9% used, resets in 63.1h
5-hour   █░░░░░░░░░░░░░░░░░░░ 4% used, resets in 4.9h

Your pace  ~2.4% of the weekly limit per day (from 48h of history)
Forecast   ~15% used by reset if Replenish does nothing
Spare now  77% (Replenish may go up to 86% now, rising to 95% at reset)

You use about 2.4%/day, so you'd reach ~15% by the reset in 63.1h. ~77% would go unused, so Replenish can spend up to 86%.
Next up: Habit tracker PWA (habit-tracker-pwa)
```

- [The idea in 30 seconds](#the-idea-in-30-seconds)
- [Requirements](#requirements) and [Install](#install)
- [Quick start](#quick-start)
- [When does it start?](#when-does-it-start)
- [What happens during a build](#what-happens-during-a-build)
- [Finding your finished project](#finding-your-finished-project)
- [Commands](#commands) and [Settings](#settings)
- [Safety](#safety)
- [Troubleshooting](#troubleshooting)

## The idea in 30 seconds

```
  you: replenish add "a habit tracker app..."        ┌──────────── queue ────────────┐
  you: replenish add "photo renamer script..."  ───▶ │ P1 habit-tracker-pwa  queued  │
                                                     │ P3 photo-renamer      queued  │
                                                     └───────────────┬───────────────┘
                                                                     │
  every hour (Task Scheduler / cron):                                ▼
    1. read your Claude usage (free, no model call)        ┌───────────────────┐
    2. learn your normal pace, hour by hour                │ spare usage that  │  no ──▶ wait for
    3. forecast where you'll be at the weekly reset  ────▶ │ you won't use?    │         next hour
                                                           └─────────┬─────────┘
                                                                     │ yes
                                                                     ▼
                          Claude Code builds the next project in ~/Replenish/<id>,
                          commits as it goes, re-checks usage every minute,
                          and stops at the safe ceiling. Unfinished work resumes next time.
```

You never have to be at your computer. You add ideas, turn it on once, and check back later.

## Requirements

- [Node.js](https://nodejs.org) 22.18 or newer
- [Claude Code](https://claude.com/claude-code), installed and logged in with a **Pro or Max** plan (run `claude` once and sign in)
- [git](https://git-scm.com)

Works on Windows, macOS and Linux. Claude Code is the only provider for now. Codex and Gemini CLI are planned.

## Install

```sh
npm install -g github:Krys301/replenish
replenish help
```

To update later, reinstall:

```sh
npm uninstall -g replenish
npm install -g github:Krys301/replenish
```

Or from a clone:

```sh
git clone https://github.com/Krys301/replenish.git
cd replenish
npm install
npm link        # makes the `replenish` command available everywhere
```

## Quick start

### 1. Check that it can see your usage

```sh
replenish status
```

You should see your plan, your weekly and 5-hour bars, and whether Replenish would start right now. Checking usage doesn't use any of your limit.

### 2. Queue what you want built

```sh
replenish add "A habit tracker PWA: daily habits, streaks, reminders, works offline. React + Vite." --priority 1
replenish add "Script that renames photos in a folder by their EXIF date" --name "Photo renamer"
replenish add --file ideas/recipe-app.md --name "Recipe app"
```

- **Write a proper brief.** Claude works alone and can't ask you questions, so say what it is, who it's for, the key features, and any tech you prefer. A paragraph or a markdown file works best.
- `--priority 1` is the most important. The default is 3.
- `--repo <path>` builds inside one of your existing repos instead of a new folder (see [Building in an existing repo](#building-in-an-existing-repo)).

```sh
$ replenish list
→ habit-tracker-pwa            P1  queued      0 run(s)
  photo-renamer                P3  queued      0 run(s)
```

The `→` marks what builds next.

### 3. Turn it on

```sh
replenish install
```

This adds an hourly check: Task Scheduler on Windows, cron on macOS and Linux. That's it. Each check records your usage, which is how Replenish learns your pace, and starts a build when there's spare.

**Want to see it work right now?** Run `replenish run`. It starts the next project immediately instead of waiting for spare usage, and still stops at your usage cap.

## When does it start?

Replenish only spends what **you** aren't going to use.

1. **It learns your pace, hour by hour.** Every hourly check records your weekly usage. From the last 14 days it works out how much you normally use **at each hour of the day**. Replenish's own runs are left out, so it never mistakes its own work for yours.
2. **It forecasts the reset.** It adds up what you usually use in each hour left before the reset. If the reset is overnight and you're never on at night, it reserves almost nothing for those hours.
3. **It keeps a reserve for you:** what you're expected to need before the reset, times a safety margin (`safetyFactor`, 1.5×). Everything above that is spare.

   ```
   ceiling = stopAtPercent − (your expected usage until reset × safetyFactor)
   ```

4. **It builds with the spare.** If at least `minLeftPercent` (10%) is spare, it starts the next project and stops when usage reaches the ceiling. As the reset gets closer your reserve shrinks, so the ceiling rises to `stopAtPercent` (95%).

So a light user gets projects built from mid-week. A heavy user only gets what's left at the very end, or nothing at all.

**While it's learning** (the first 24 hours of history), it uses a simple rule instead: spend what's left in the last `windowHours` (24h) before the reset. To always use that rule: `replenish config strategy deadline`.

See your own pattern with `replenish analyze`:

```
  12:00  █████████████████              0.25%/h
  14:00  ██████████████████████████████ 0.45%/h
  17:00                                 0.00%/h
Average: 2.2% of your weekly limit per day.
Your quiet hours: 17-9. To have Replenish build only then: replenish config activeHours auto
```

**It won't:**
- start while you're using Claude yourself (`skipIfUserActive`)
- run outside the hours you choose (`activeHours`: `22-7` for overnight, or `auto` for your learned quiet hours)
- go past `stopAtPercent` on the weekly **or** the 5-hour limit, so you're never locked out
- touch next week's usage: if the limit resets mid-run, it stops

**It won't waste a 5-hour window either.** If the 5-hour limit fills up but weekly spare remains and the window resets within 90 minutes, Replenish waits and then carries on.

## What happens during a build

1. **A folder is made** at `~/Replenish/<project-id>`, as a fresh git repo.
2. **Claude Code starts headless** in that folder with your brief. It's told it's running unattended: plan first, commit after every step, keep notes in `REPLENISH.md`, and never push, deploy or spend money.
3. **Usage is re-checked every minute.** When it reaches the ceiling, Replenish asks Claude to stop at a clean point. The project is marked `in_progress` and continues **in the same Claude session** next time, so nothing is lost.
4. **Claude ends each round with a status:** `done`, `continue` (more to do, keep going if there's spare), or `blocked` (it needs you, and `REPLENISH.md` says why).
5. **A report is written** to `~/.replenish/reports/`, and the result is printed (below).

If you ran it yourself with `replenish run`, you get a live progress line and a ✓ for every commit:

```
  ✓ Add REPLENISH.md with project plan
  ✓ Add temp.js CLI for Celsius/Fahrenheit conversion
[/] 1m 10s · 3 commits · weekly 11% → 12% · Running: Run the test suite via npm test
```

The terminal is busy until the build ends, because Claude is working on its own and doesn't need input. Press **Ctrl+C** to stop: the work is kept and resumes next time. Long steps (installing packages, compiling) can sit on the same line for several minutes. That's normal.

### What about permissions?

There are **no popups and nothing to approve**, and a build never sits waiting for you:

- Builds run in Claude Code's `auto` permission mode (`permissionMode`), so normal work like editing files, running tests and installing packages goes ahead on its own.
- If Claude tries something that would normally need your approval, Replenish answers "no, you're unattended" straight away. Claude then finds another way, or, if it really needs you (an API key, an account, a decision), it marks the project `blocked` and writes what it needs in `REPLENISH.md`.
- Your hooks are switched off for build sessions, and builds only ever work in their own folder or branch.

### What order do projects build in?

Unfinished (`in_progress`) projects always go first, so a half-built project gets finished before a new one starts. Then queued projects by priority (1 first), then oldest first. `replenish list` shows what's next with `→`. To build a specific one now: `replenish run <id>`.

### Building in an existing repo

```sh
replenish add "Add dark mode and an export-to-CSV button" --repo C:\code\my-app
```

Replenish never touches your checkout. It creates a `replenish/<id>` branch in a separate git worktree at `~/Replenish/<id>`, and Claude works there. When it's done, review and merge the branch like any other.

The folder must already be a git repo **with at least one commit**, since git can't branch from an empty repo. `replenish add` checks this and tells you how to fix it if not.

## Finding your finished project

When a build ends, Replenish tells you exactly where the project is:

```
────────────────────────────────────────────────────────────────────────
✅ Finished: ESP32 learning template
   Folder:     C:\Users\you\Replenish\esp32-learning-template
   Open it:    replenish open esp32-learning-template
   Read first: README.md (how to use it), REPLENISH.md (what was built, decisions, next steps)
   Report:     C:\Users\you\.replenish\reports\2026-11-24-21-03-esp32-learning-template.md
   It's a local git repo with 2 commits. Nothing was pushed online.
────────────────────────────────────────────────────────────────────────
```

Builds from the hourly task finish while you're away, so you can find them any time:

```sh
replenish show                   # every built project: where it is and its status
replenish show esp32             # one project in detail, with Claude's summary (any start of the id works)
replenish open                   # open the latest project in VS Code (File Explorer if VS Code isn't installed)
replenish open esp32 --folder    # open it in File Explorer instead
```

**Where everything lives:**

| What | Where |
|---|---|
| Projects | `~/Replenish/<project-id>/`, each its own local git repo |
| Reports | `~/.replenish/reports/`, one per run: what changed, why it stopped, usage before and after, commits |
| Queue, settings, usage history | `~/.replenish/` |
| Log of the hourly task | `~/.replenish/replenish.log` |

Nothing is ever pushed online. When you're happy with a project, publish it yourself, for example with GitHub Desktop (*File → Add local repository → Publish*) or `gh repo create --source . --push`.

## Commands

| Command | What it does |
|---|---|
| `replenish add "<brief>" [--name] [--priority 1-5] [--repo <path>] [--file <brief.md>]` | Queue a project |
| `replenish list` | The queue, with what's next |
| `replenish show [<id>]` | Where built projects are (all, or one in detail) |
| `replenish open [<id>] [--folder]` | Open a project in VS Code or File Explorer |
| `replenish status` | Usage, forecast, the start decision, and what's next |
| `replenish analyze` | Your usage by hour of day, and your quiet hours |
| `replenish run [<id>] [--dry-run]` | Build now without waiting for spare usage |
| `replenish tick [--dry-run]` | One hourly check, exactly what the scheduler runs |
| `replenish requeue <id>` | Send a done/blocked/failed project back for more work |
| `replenish remove <id>` | Delete from the queue (the project folder is kept) |
| `replenish pause` / `resume` | Kill switch: stop everything now / re-enable |
| `replenish install` / `uninstall` | Turn the hourly check on / off |
| `replenish config [<key> [<value>]]` | Show or change settings |

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
| `stopAtPercent` | `95` | Never let weekly **or** 5-hour usage go past this |
| `activeHours` | any time | Only run in these local hours, e.g. `22-7`, or `auto` for your learned quiet hours |
| `maxRunMinutes` | `180` | Watchdog: force-stop a Claude session that runs longer than this (it resumes next time) |
| `skipIfUserActive` | `true` | Don't start while you're using Claude yourself |
| `checkIntervalSeconds` | `60` | How often usage is re-checked during a build |
| `model` | Claude Code default | e.g. `sonnet`, `opus`, `haiku` |
| `permissionMode` | `auto` | Claude Code permission mode for builds |
| `projectsDir` | `~/Replenish` | Where new projects are created |
| `claudePath` | found on `PATH` | Full path to `claude`, if the scheduler can't find it |

## Safety

An unattended loop that starts Claude sessions can go wrong fast. One known failure is a hook that starts `claude -p` and chains into hundreds of sessions, burning a whole 5-hour window. Replenish guards against that and more:

| Guard | What it prevents |
|---|---|
| **Kill switch:** `replenish pause` | Nothing starts, and a running build stops within a minute |
| **Hooks off in builds** | Your hooks can't fire on every round or start more sessions |
| **No recursion** | Build sessions are marked. If anything inside one runs `replenish`, it refuses |
| **One run at a time** | A lock file. A crashed run's stale lock is detected and cleared |
| **Usage-aware stopping** | Live usage checked every minute against the ceiling and `stopAtPercent` |
| **Never runs blind** | If usage can't be read 3 times in a row, the build stops |
| **Watchdog** | A session longer than `maxRunMinutes` is interrupted, then killed if it ignores that |
| **Bounded rounds** | At most 10 rounds per run. 3 failed runs in a row mark a project `failed` |
| **Sandboxed work** | Own folder or branch only. Never pushes, deploys, or spends money |
| **Your login stays yours** | Replenish never reads your credentials. Everything goes through your own `claude` install |

Usage is read through the same numbers Claude Code's `/usage` shows, without calling the model, so checking costs nothing.

## Troubleshooting

| Problem | Fix |
|---|---|
| `replenish status` can't read usage | Run `claude` once and make sure you're logged in with a Pro or Max plan. If the scheduler can't find Claude, set `replenish config claudePath <full path to claude>` |
| `Can't use --repo: … has no commits yet` | `cd` into the repo and run `git add -A` then `git commit -m "Initial commit"` |
| `Can't use --repo: The folder … doesn't exist` | Check the path. Use the full path, e.g. `C:\Users\you\my-app` |
| A project shows `blocked` | Read `REPLENISH.md` in its folder (`replenish show <id>`) to see what it needs. Sort it out, then `replenish requeue <id>` |
| Nothing ever starts | `replenish status` says why. Usually: you're expected to use your limit, it's outside `activeHours`, you're using Claude right now, or it's still learning (first 24h) |
| Progress line hasn't moved for minutes | Claude is in a long step (installing, compiling). It updates when the step finishes. Ctrl+C is safe |
| Install fails or `replenish` isn't found | Reinstall: `npm uninstall -g replenish` then `npm install -g github:Krys301/replenish` |

Your computer needs to be awake for the hourly check to run.

## Uninstall

```sh
replenish uninstall      # removes the hourly check
npm uninstall -g replenish
```

Your projects in `~/Replenish` and data in `~/.replenish` are left alone. Delete them if you want.

## Things to know

- Replenish reads usage through a Claude Code interface that isn't officially documented. A Claude Code update could break it. If `replenish status` stops working, please open an issue.
- Use it within your plan's terms. Replenish only automates *your own* Claude Code on *your own* account.

## Roadmap

- More providers: OpenAI Codex, Gemini CLI (`src/providers/types.ts` is the plug-in point)
- Desktop notifications when a build finishes
- `replenish add --interactive`: Claude interviews you to turn a one-liner into a solid brief
- launchd on macOS

## Development

```sh
npm install
npm test             # runs the TypeScript tests directly with node --test
npm run typecheck
npm run compile      # compiles to dist/ (committed: run this before committing src/ changes)
REPLENISH_HOME=/tmp/rh npm run dev -- status   # use a throwaway data folder
```

`dist/` is committed on purpose. Don't add `build`, `prepare` or `install` scripts to `package.json`: they make `npm install -g github:...` fail.

## License

MIT
