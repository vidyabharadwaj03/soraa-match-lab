# Soraa Match Lab

Built at the Archil Agent Hackathon. A fleet of AI agents that finds and researches real creators for a brand and writes a curated, sourced shortlist: the "matching brain" for [Soraa](https://joinsoraa.com), a brand-creator partnership marketplace.

**How it works**

1. You describe your brand and the creators you want.
2. A **planner** agent searches the live web (Keenable) for candidate creators.
3. One **worker** agent per creator runs in parallel and writes `profile.md`, `partnerships.md`, `fit.md` (scored) and `sources.md` to a shared [Archil](https://archil.com) disk.
4. A **synthesizer** reads every folder and writes `REPORT.md`: a ranked top 3 with a human-readable "why this match", risks and source links.
5. Every tool call is appended to `runs/<id>/audit.jsonl` on the disk.

Each run lives in its own folder on one persistent Archil disk, so a human and the agents share the same workspace and past runs stay browsable.

## Run it

```bash
npm install
cp .env.example .env     # add your Archil, Anthropic (and optionally Keenable) keys
npm start                # http://localhost:3000
```

Defaults to the cheapest Claude model (`claude-haiku-5-5`). Set `FLEET_MODEL` to change it.

## Files

- `fleet.ts`: the planner / workers / synthesizer pipeline
- `app.ts`: small HTTP server (start runs, poll progress, read files off the disk)
- `index.html`: the UI

## Caveats

Creator data comes from the open web and is often approximate or undated (social platforms are hard to scrape). Reports flag unknowns, but verify numbers and rates before reaching out.
