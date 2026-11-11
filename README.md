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

**Stories**: the story's title in the top bar is a dropdown that lists the stories and switches
between them. Its last entry, "New story…", makes one the same way you add a
node: a title and a short overview (the jacket cover), which become the story's
first page. In Voice you can say "add new story" and dictate both. The ⋯ menu
shows the open story's overview, adds a story from a JSON file, downloads the
open story as JSON, and deletes a story of yours or removes what you added to a
built-in one.

Three modes, sharing your place in the story:

- **Map**: the whole story's shape, titles only. Click a page to edit it; the
  edit form also has "Read from here".
- **Read**: a page of text with the choices as buttons.
- **Voice**: one big button, made for a phone. Tap once and it reads the page
  and the choices. Then hold the button, say your answer, and let go. Holding
  while it reads interrupts it. Drag the glowing label on the button (it names the
  mode it's in) half way around to switch to Hands Free, which opens the mic after each reading; there
  the button is START and STOP, and START picks up where you stopped. Drag
  Restart clockwise or Repeat counterclockwise around the button to confirm
  them. The strip at the bottom shows what it's doing and what it hears; tap it for a log of how
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

**Editing a node**: next to "Add new node" is "Edit this node", and every node
on the Map opens the same form: the creation form with the node's title and
text already in it. In Voice, say "edit this node" and it asks the same
questions as for a new node; "keep it" at the title or the text leaves that
part as it was. Only the words change: the node's place and its choices stay.
Editing a story's first page renames the story if it was named after that page.

**A better voice (experimental)**: under Voice settings, the Voice switch goes
from Browser to Model: Small or Model: Large. The model is
[Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), a neural
voice that runs in the page: nothing is sent anywhere and there's no key or
cost, but it's a big download the first time (roughly 90 MB for Small, 310 MB
for Large), shown on a progress bar and then kept by the browser. Small runs on
the processor; Large wants a browser with WebGPU. The browser voice reads while
the model loads, and takes over for any sentence the model can't do. On the processor it makes speech slower than it plays (about 2.5 times slower
on a test machine), so expect pauses: the status says "Making the voice…"
while it works, it uses the time you spend listening and deciding to get ahead,
and anything already made is kept for a Repeat. "Test the voice" under the
switch makes and plays one sentence and says how long it took; the voice log
has the same timing for every sentence. This is
the one feature that fetches code and data from outside this folder (jsDelivr
and Hugging Face).

**A cloud voice (experimental)**: the last stop on the Voice switch is Cloud,
which sends each sentence to OpenAI's speech service (`gpt-4o-mini-tts`) and
plays what comes back. It needs your own OpenAI API key, pasted under the
switch: it's kept in that browser only and sent only to OpenAI. It reads in two voices, each with its own picker: a story
voice (Marin to start) for the story's own words, and an app voice (Cedar) for
the app's prompts and instructions, matching the two typefaces on the page. The cost is
roughly 1.5 cents per thousand characters read, so a few cents for a story
like the sample; the panel shows how much has been sent from that browser. A
sentence already fetched is kept until the page is reloaded and isn't paid for
twice. Without a key, with a refused key, or offline, the browser voice reads.
This suits one person with their own key; a public site would need a small
server to hold the key instead.

**Shorter prompts**: the first time Voice asks for something it explains what
you can say ("Which will it be? Say its number, or its name."). After that the
same prompt is a few words ("Choices:", "Keep?", "Text?"). If a short prompt
gets no usable answer, or about fifteen seconds pass with no press in Hold To
Talk, it reads the full one after all. Saying "help" brings the explanations
back. What's been explained is remembered per browser.

**Keeping the screen on**: once a story is going in Voice, the page asks the
phone not to dim and lock, since that stops the reading. "Keep the screen
awake" under Voice settings turns this off. It only applies while the Voice
page is showing; the phone can still refuse (Low Power Mode, for one).

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
