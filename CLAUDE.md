# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

StoryNode: choose-your-own-adventure stories with three modes (Map, Read,
Voice) on one static page. Plain JavaScript ES modules, no build, no
dependencies, no server. A recreation of an earlier project that ran on
Amazon Alexa; the point now is cheap, in-browser voice play.

Run: `python3 -m http.server 8000`. Test: `node tests/run.mjs` (Node 22+).

## Layout

- `index.html`, `style.css`: the page. Modes switch on the URL hash (`#map`, `#read`, `#voice`).
- `src/app.js`: UI and the voice loop (read page → read choices → listen → act). A `run`
  counter cancels stale async steps when the user taps or changes mode.
- `src/story.js`: the story model. Nodes have `id`, `title`, `text`, `parent` (string or
  list) and optional `aliases`; choices are the children. Validates ids, parents, loops.
- `src/matcher.js`: turns recognizer guesses into a choice (number, title/alias) or a
  command. Picks a title only when it clearly wins on words no other choice has;
  otherwise returns `none` so the app asks again. Sound-alikes ("choice to" → 2) only
  right after choice/option/number, as the last word.
- `src/speech.js`: wrappers over `speechSynthesis` (one sentence per utterance,
  because Chrome cuts long ones off) and `SpeechRecognition` (`listenOnce`: fresh
  non-continuous sessions, re-armed while a press is held, merged into up to 5 guesses,
  phrase hints when supported, timeouts for sessions that never end).
- `src/voicelog.js`: entries and wording for the voice log popup.
- `src/layout.js`: map layout (rows by longest path, ordered by parents' positions).
- `src/script.js`: everything voice mode says.
- `stories/lighthouse.json`: the sample story.

## Decisions

- Browser-only speech first: free and needs no keys. Chrome and Safari; Firefox can't listen.
- The first `speak()` must come from a tap (Safari), so voice mode starts on a button.
- The mic is off while the app is speaking, so it doesn't hear itself.
- Hold To Talk is the default; hands-free is an option because Safari, iPhone especially,
  may refuse a mic that no press started.
- No `continuous` recognition: it's the mode iOS Safari is reported to stall in.
- Keep pure logic in modules without DOM access, with tests in `tests/run.mjs`.
