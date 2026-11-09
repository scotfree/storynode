# Story Mode

Choose-your-own-adventure stories you can read, map, or **play by voice**.

A story is a directed graph of pages. Each page has a title and some text; its
choices are the pages that list it as their parent, offered by their titles.
Voice mode reads a page and its choices aloud, then listens for your answer:
"choice two", "the beach", or a command like "repeat" or "go back".

Everything runs in the browser: no server, no build step, no dependencies.
Reading aloud and listening use the browser's own Web Speech API.

## Run it

```bash
python3 -m http.server 8000
```

Open http://127.0.0.1:8000. The microphone needs a secure page: `127.0.0.1`
and `localhost` count, but a phone on your network needs HTTPS (e.g. GitHub
Pages).

Three modes, sharing your place in the story:

- **Map**: the whole story's shape, titles only. Click a page to read from there.
- **Read**: a page of text with the choices as buttons.
- **Voice**: one big button, made for a phone. Tap Start; it reads the page and
  the choices, then listens. Tap while it's reading to answer straight away.

Voice works in Chrome and Safari (Firefox can't listen). Better voices help a
lot: on a Mac or iPhone, download an "Enhanced" or "Premium" voice in the
system's accessibility settings, then pick it under Voice settings.

## Tests

```bash
node tests/run.mjs
```

The story model, choice matching, map layout and spoken wording are pure
modules with unit tests. The browser speech APIs are thin wrappers in
`src/speech.js`.

## Story format

```json
{
  "title": "The Lighthouse at Gull Point",
  "start": "start",
  "nodes": [
    { "id": "start", "title": "The Lighthouse at Gull Point", "text": "The ferry leaves you…" },
    { "id": "beach", "title": "Walk down to the beach", "text": "The tide is out…",
      "parent": "start", "aliases": ["the beach", "the shore"] },
    { "id": "cave", "title": "Explore the sea cave", "text": "…", "parent": ["beach", "bottle"] }
  ]
}
```

- `parent`: the page this one is reached from. A list means several pages lead
  here (paths that merge). No parent means it's a start page.
- `start`: optional; defaults to the first page with no parent.
- `aliases`: optional extra ways to say the choice out loud.
- A page with no children is an ending.
- Stories must only go forward (no loops).

Open your own story from the ⋯ menu. The sample is `stories/lighthouse.json`.

## How choosing by voice works

At each page the app knows the few possible answers, so recognition is a tiny
problem rather than general dictation:

1. The browser's recognizer returns a few guesses for what was said, biased
   toward the current choices where the browser supports phrase hints.
2. `src/matcher.js` checks each guess for a number ("two", "choice two", "the
   second one"), a command ("repeat", "choices", "go back", "start over",
   "help", "stop"), or a title or alias, picking a choice only when one clearly
   wins (a word only it has). Otherwise it asks again.

## Ideas for later

- An editor in Map mode (add and edit pages, drag to re-parent).
- Pre-recorded audio per page from a good neural voice, falling back to the
  browser's voice.
- Offline or Firefox listening with a grammar-limited recognizer in the page
  (SoundSwallower or Vosk), or an audio model that must answer with one of the
  choices for very natural phrasing.
- Speaking while listening ("barge-in"), so you can answer mid-sentence.

## Moving to its own repo

This folder started inside another repo. To split it out with its history:

```bash
git subtree split --prefix=storymode -b storymode-only
```

```bash
git push git@github.com:OWNER/storymode.git storymode-only:main
```

`.github/workflows/test.yml` starts running once it's at the new repo's root.
