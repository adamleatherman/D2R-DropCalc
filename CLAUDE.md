# D2R drop calculator

Static web app (no build step, no npm): `engine.js` holds all the math (no DOM), `app.js` + `index.html` the UI, `worker.js` the
item builder's background work, `build.py` turns the game tables into `data.json` (RotW) and `data-lod.json` (LoD). The README
is the full reference (formulas, sources, tab-by-tab behaviour); keep it in step with changes.

## Work on two machines

This repo is worked on from more than one computer. Pull before starting, push before stopping: an unpushed commit on one
machine turns the next pull on the other into a merge. Notes for the other machine go in the repo (here, `docs/plans/`), not in
per-machine memory.

## Game tables (`excel/`)

The extracted game tables are gitignored (game files; the repo is public) and only exist on a machine where someone ran
`python tools/extract_tables.py` (needs D2R installed; `--game <folder>` for a non-default install). Without them:
the app runs, but `build.py` and `test_engine.py` do not. Check `ls excel` before planning work that needs them; never commit them.

Data changes: extract -> `python build.py` -> `python test_engine.py` -> commit `data.json` + `data-lod.json` with the code.

## Tests

`python test_engine.py` (needs `excel/`): starts its own local server, runs `test.html` / `tests.js` in headless Edge or
Chrome, and checks the engine against an independent Python reference. Node is not needed. It ends with
`N checks, M failures`; grep the output for `^FAIL`. A failing check may be a stale test after an intended engine change:
check the commit that changed the behaviour before changing the engine.

To look at engine values the tests do not print, a throwaway page in the repo root that does
`Engine.create(await (await fetch('data.json')).json())` and writes JSON into a `<pre id="out">`, run the same way
(headless `--dump-dom` via a local `python -m http.server`), works; delete it afterwards.

## Conventions

* Line endings: the repo stores LF; Windows checkouts (`core.autocrlf=true`) have CRLF on disk. Scripted edits must keep
  whatever the file has.
* Commit messages: one long descriptive subject line in plain words (what changed, where in the UI), no type prefixes.
* Plans live in `docs/plans/<topic>.md` with a `Status:` line at the top; update it when work starts or ships.
