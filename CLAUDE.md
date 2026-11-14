# CLAUDE.md

Guidance for Claude Code in this repository.

## What this is

StoryNode: choose-your-own-adventure stories with three modes (Map, Read,
Voice) on one static page. Plain JavaScript ES modules, no build, no
dependencies, no server. A recreation of an earlier project that ran on
Amazon Alexa; the point now is cheap, in-browser voice play.

Run: `python3 -m http.server 8000`. Test: `node tests/run.mjs` (Node 22+).

## Layout

- `storynodelogo.png`: the logo as drawn (black on transparent). `logo.png` (the top bar,
  inverted in dark mode) and `favicon.png` / `apple-touch-icon.png` (on a cream tile) are
  made from it with the lines thickened, so they survive being small.
- `index.html`, `style.css`: the page. Modes switch on the URL hash (`#map`, `#read`, `#voice`).
- `src/app.js`: UI and the voice loop (read page → read choices → listen → act). A `run`
  counter cancels stale async steps when the user taps or changes mode.
- `src/story.js`: the story model. Nodes have `id`, `title`, `text`, `parent` (string or
  list) and optional `aliases`; choices are the children. Validates ids, parents, loops.
  `addNode` appends a node under a parent in the JSON form, making its id from the title;
  `editNode` changes a node's title and text and keeps its id. `connectNode` adds a parent
  to an existing node; `connectable` lists the nodes that wouldn't make a loop.
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
- `src/player.js`: plays clips as WAV files through one reused `<audio>` element.
- `src/library.js`: the list of stories (built-in plus this browser's) and `createStory`.
- `src/compose.js`: the spoken conversation for dictating a new node or story (title → read back →
  text in parts until "done" → read back → save), as a pure step function.
- `src/connect.js`: the spoken exchange for connecting to an existing node (ask for a title,
  two misses, then read the list), as a pure step function.
- `src/voicelog.js`: entries and wording for the voice log popup.
- `src/arc.js`: tracks a drag around the big button as a signed sweep, for the arc
  controls (Repeat, Restart, mode dial).
- `src/layout.js`: map layout (rows by longest path, ordered by parents' positions), the
  Cartesian fisheye that fits it into a frame around a focus, a spring layout
  (`forceLayout`), and zoom arithmetic.
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
  edit form, which carries "Read from here" so the map still navigates, and "add new node"
  and "connect node" for the node being edited (saving the form's changes first). Ids never change
  on edit, so saved places and links between nodes hold.
- "Connect node" makes an existing node a choice here by adding the current node to its
  `parent` list; that's the whole change. Candidates exclude the node, its choices and
  everything upstream of it. By voice the title is matched like a choice (unique words, or
  the exact title), numbers only count once the list has been read out, and the match is
  applied without a read-back, as asked; there is no disconnect yet.
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
- Looks: story words (titles, text, choices, map nodes) are typewritten (American
  Typewriter on Apple devices, Courier elsewhere; device fonts only, nothing downloaded),
  sized for Courier's width; everything you operate is Helvetica/Arial. The story's title in the top bar is the story picker. On
  the voice page the status line lives in the bottom strip with what was heard, the mode
  dial carries its own label, and held it shows the other mode at the far side with two
  arrows. The map's svg is `map-svg`, not `map`, or the `#map` hash scrolls to it.
- The map has three looks, remembered in `storynode_map`. Normal: the layout at a zoom,
  scrolled natively (`touch-action: pan-x pan-y`), with pinch handled by the page from touch
  events, Safari's gesture events and ctrl + wheel. Fisheye: each axis distorted on its own
  around a focus that follows the mouse or a dragged finger; a map that already fits isn't
  distorted. Node elements are built once per render and only moved afterwards, so a
  gesture never replaces the element under the finger; clicks right after a pinch or drag
  are swallowed. Physics: Normal's scrolling and zoom over `forceLayout`, a
  Fruchterman-Reingold spring layout written here (no library, keeping "no dependencies"):
  deterministic because it starts from the layered layout, repulsion cut off beyond three
  spring lengths, a light pull to the middle, then a pass that pushes overlapping boxes
  apart; edges are straight. It's cached per story object. The map scrolls inside a
  frame that ends at the window's bottom, so the look switch stays in reach. A green ring marks the start node and blue rings the endings.
- A started story in voice mode holds a screen wake lock (the phone locking mid-page stops
  the reading), re-asked whenever the page becomes visible again, and released on leaving
  voice mode. On by default, with a switch in Voice settings.
- Prompts come as `{ key, full, brief }` (`choicesPrompt` in script.js, steps from
  compose.js). The full form explains what can be said; once it has been read through, its
  key goes in localStorage (`storynode_heard`) and the brief form is used from then on. A
  brief prompt keeps its full text in `voice.fallback`: an unusable answer, hands-free
  silence, or `HELP_AFTER_MS` without a press in Hold To Talk reads it. Lines with no key
  (anything said because an answer was unclear) are always full. "help" clears the keys.
- Two voices mirror the two typefaces: story words in one, the app's own words in another.
  Scripts stay plain strings; `voiceParts` in script.js works out the role afterwards from
  the story words in play (this page, its choices, anything being dictated). A sentence is
  the story's if it is one of those, and "label: story words" is split at the colon, each
  part its own clip. `speak()` takes `partsOf`, and clip sources get `role`; only the
  cloud voice acts on it (a voice and a line of direction per role), the others ignore it.
- Clips play through an `<audio>` element, not Web Audio. On Apple devices Web Audio is
  "ambient" sound that the silent switch mutes, while the browser voice is still heard. (A
  silent cloud voice once turned out to be the phone still routing to a car's CarPlay
  audio; the browser voice took the phone speaker. Check output routing before the code.)
  The element is unlocked once from a tap and reused; each clip's outcome
  (played, blocked, failed, stuck past its length) goes in the voice log, and any failure
  hands the sentence to the browser voice instead of leaving silence.
- Keep pure logic in modules without DOM access, with tests in `tests/run.mjs`.
