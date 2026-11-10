# StoryNode

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

**Stories**: the dropdown under the top bar lists the stories and switches
between them. Its last entry, "New story…", makes one the same way you add a
node: a title and a short overview (the jacket cover), which become the story's
first page. In Voice you can say "add new story" and dictate both. The ⋯ menu
shows the open story's overview, adds a story from a JSON file, downloads the
open story as JSON, and deletes a story of yours or removes what you added to a
built-in one.

Three modes, sharing your place in the story:

- **Map**: the whole story's shape, titles only. Click a page to read from there.
- **Read**: a page of text with the choices as buttons.
- **Voice**: one big button, made for a phone. Tap once and it reads the page
  and the choices. Then hold the button, say your answer, and let go. Holding
  while it reads interrupts it. Drag the glowing knob on the button half way
  around to switch to Hands Free, which opens the mic after each reading; there
  the button is START and STOP, and START picks up where you stopped. Drag
  Restart clockwise or Repeat counterclockwise around the button to confirm
  them. The panel at the bottom shows what it hears; tap it for a log of how
  each answer was matched.

**Adding a node**: under the choices in Read and Voice there's a small "Add new
node" link, and in Voice you can say "add new node" (it's never read out as a
choice). Give it a title and some text and it becomes a new choice after the
page you're on. Anyone can add for now.

The link opens a form to type into. Saying it starts a spoken version instead:
it asks for the title and reads it back, then takes the text a sentence or two
at a time until you say "done", and reads the whole page back. At each
read-back say "keep it", "try again" or "cancel"; while giving the text,
"scratch that" drops the last part. Afterwards you're still on the same page,
with the new choice read out among the others.
 It's saved with the story in this
browser only.

**A better voice (experimental)**: under Voice settings, the Voice switch goes
from Browser to Model: Small or Model: Large. The model is
[Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), a neural
voice that runs in the page: nothing is sent anywhere and there's no key or
cost, but it's a big download the first time (roughly 90 MB for Small, 330 MB
for Large), shown on a progress bar and then kept by the browser. Small runs on
the processor; Large wants a browser with WebGPU. The browser voice reads while
the model loads, and takes over for any sentence the model can't do. This is
the one feature that fetches code and data from outside this folder (jsDelivr
and Hugging Face).

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

- `overview`: optional jacket-cover text; without it, the first page's text is used.

Built-in stories are the files in `stories/` named in `stories/index.json`
(`["lighthouse"]` is `stories/lighthouse.json`). To ship a story made in the
browser, download it from the ⋯ menu, put it in `stories/` and add its name to
the index. Stories made or added to in the browser are kept in that browser's
local storage.

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
