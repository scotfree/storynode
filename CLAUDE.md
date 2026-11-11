# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

StoryNode: choose-your-own-adventure stories with three modes (Map, Read,
Voice) on one static page. Plain JavaScript ES modules, no build, no
dependencies, no server. A recreation of an earlier project that ran on
Amazon Alexa; the point now is cheap, in-browser voice play.

Run: `python3 -m http.server 8000`. Test: `node tests/run.mjs` (Node 22+).

## Layout

- `favicon.svg` (and two PNGs rendered from it): the logo, SN as nodes and edges.
- `index.html`, `style.css`: the page. Modes switch on the URL hash (`#map`, `#read`, `#voice`).
- `src/app.js`: UI and the voice loop (read page → read choices → listen → act). A `run`
  counter cancels stale async steps when the user taps or changes mode.
- `src/story.js`: the story model. Nodes have `id`, `title`, `text`, `parent` (string or
  list) and optional `aliases`; choices are the children. Validates ids, parents, loops.
  `addNode` appends a node under a parent in the JSON form, making its id from the title;
  `editNode` changes a node's title and text and keeps its id.
- `src/matcher.js`: turns recognizer guesses into a choice (number, title/alias) or a
  command. Picks a title only when it clearly wins on words no other choice has;
  otherwise returns `none` so the app asks again. Sound-alikes ("choice to" → 2) only
  right after choice/option/number, as the last word.
- `src/speech.js`: wrappers over `speechSynthesis` (one sentence per utterance,
  because Chrome cuts long ones off) and `SpeechRecognition` (`listenOnce`: fresh
  non-continuous sessions, re-armed while a press is held, merged into up to 5 guesses,
  phrase hints when supported, timeouts for sessions that never end).
- `src/clipspeaker.js`: a speaker with the same shape as the browser one, but playing audio
  clips from a `source`, a sentence at a time, with the browser voice as fallback.
- `src/modelvoice.js`, `src/model-worker.js`: the Kokoro model as a clip source. The worker
  imports kokoro-js from a CDN on demand; the main side queues sentences and caches clips.
- `src/cloudvoice.js`: OpenAI's speech API as a clip source, called straight from the
  browser with the listener's own key.
- `src/player.js`: plays clips through Web Audio.
- `src/library.js`: the list of stories (built-in plus this browser's) and `createStory`.
- `src/compose.js`: the spoken conversation for dictating a new node or story (title → read back →
  text in parts until "done" → read back → save), as a pure step function.
- `src/voicelog.js`: entries and wording for the voice log popup.
- `src/arc.js`: tracks a drag around the big button as a signed sweep, for the arc
  controls (Repeat, Restart, mode dial).
- `src/layout.js`: map layout (rows by longest path, ordered by parents' positions).
- `src/script.js`: everything voice mode says.
- `stories/index.json`: names of the built-in stories; `stories/lighthouse.json` is the sample.

## Decisions

- Browser-only speech first: free and needs no keys. Chrome and Safari; Firefox can't listen.
- The first `speak()` must come from a tap (Safari), so voice mode starts on a button.
- The mic is off while the app is speaking, so it doesn't hear itself.
- Hold To Talk is the default; hands-free is an option because Safari, iPhone especially,
  may refuse a mic that no press started.
- Repeat and Restart are disabled until the story has started: they fire mid-drag, which
  Safari doesn't accept as the gesture that unlocks speech.
- No `continuous` recognition: it's the mode iOS Safari is reported to stall in.
- "Add new node" is a voice command and a small link under the choices, never read out
  as a choice. Added nodes are saved with the whole story in localStorage (no server yet);
  anyone can add until roles exist. The link opens a typed form; the voice command
  dictates. Dictation keeps the recognizer's first guess word for word, so each part is
  read back and confirmed, and its commands (done, scratch that, cancel) only count as
  the whole utterance. Text comes in several short utterances, since there's no
  `continuous` mode.
- Editing reuses creation: the same form, filled in, and the same dictation with `kind`
  'edit' (where "keep it" at a question leaves that part unchanged). Map nodes open the
  edit form, which carries "Read from here" so the map still navigates. Ids never change
  on edit, so saved places and links between nodes hold.
- Several stories: built-ins are fetched from `stories/` via `index.json` (a static page
  can't list a folder); anything made, opened or added to in the browser lives in
  localStorage under `storynode_library`, keyed by story id, and a built-in's id there
  overrides the file. A new story is made exactly like a node (same form, same dictation):
  its title and overview become its first page, so there's no separate cover screen.
- Voices are swappable behind the speaker shape (`speak`, `cancel`, `position`, `unlock`,
  `setRate`). Anything that isn't the browser voice should be a new clip source for
  `clipspeaker.js` (returning null to hand a sentence to the browser voice), not a new
  speaker. The model voice is opt-in and the only exception to "no dependencies": nothing
  from outside is loaded unless it's switched on. Speed goes to the model as its own
  `speed`, not as playback rate, so pitch stays put.
- The small model on WASM makes speech about 2.5× slower than it plays (measured in
  headless Chromium; the audio itself is fine). So every sentence of a reading is queued
  up front, the openings of each choice's page are made while waiting for an answer, a
  silent or non-finite clip counts as a failure, and each clip's timing goes in the voice
  log. Cross-origin isolation (threads) was measured at only ~25% faster, so it wasn't
  worth a service-worker shim on a static host.
- The cloud voice is bring-your-own-key because there's no server to hide one: the key
  lives in localStorage (`storynode_cloud`) and never in the repo. Requests go three at a
  time, so a page abandoned early isn't all paid for, and choices are not pre-made for
  the cloud voice for the same reason. It asks for raw `pcm` (24 kHz, 16-bit), which
  needs no decoding. A refused key or an empty account stops requests until the key
  changes; anything else costs one sentence, read by the browser voice.
- Voice reads a page's text without its title: the title was the choice just made. Only
  the story's first page reads its title, since nobody chose it.
- Looks: story words (titles, text, choices, map nodes) are set in Times; everything you
  operate is Helvetica/Arial. The story's title in the top bar is the story picker. On
  the voice page the status line lives in the bottom strip with what was heard, the mode
  dial carries its own label, and held it shows the other mode at the far side with two
  arrows. The map's svg is `map-svg`, not `map`, or the `#map` hash scrolls to it.
- Keep pure logic in modules without DOM access, with tests in `tests/run.mjs`.
