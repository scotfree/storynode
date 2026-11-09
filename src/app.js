// StoryNode: one page, three modes that share your place in the story.
//   #map   — the whole story's shape (titles only); click a node to read it
//   #read  — a page of text, with the choices as buttons
//   #voice — a big button: it reads the page and the choices, then listens

import { loadStory, choicesOf, isEnding } from './story.js';
import { layoutGraph } from './layout.js';
import { match, hintPhrases } from './matcher.js';
import { createSpeaker, listenOnce, support, rankVoices } from './speech.js';
import { pageScript, choicesScript, HELP_SCRIPT, retryScript } from './script.js';

const SAMPLE_URL = 'stories/lighthouse.json';
const STORY_KEY = 'storynode_story';   // a story opened from a file
const VOICE_KEY = 'storynode_voice';   // { name, rate, auto }
const MAX_RETRIES = 2;

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, text) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
};
const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
};

const speaker = createSpeaker();
const can = support();

let story = null;
let currentId = null;
let history = [];              // ids before the current one, for Back
const visited = new Set();

// --- storage (wrapped: private windows can refuse it) ---

function readJson(key) {
    try {
        return JSON.parse(localStorage.getItem(key));
    } catch {
        return null;
    }
}

function writeJson(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Not saved; fine for a prototype.
    }
}

// --- story and position ---

function useStory(data) {
    const { story: loaded, errors } = loadStory(data);
    if (errors.length) return errors;
    story = loaded;
    history = [];
    visited.clear();
    goTo(story.start, { remember: false });
    return [];
}

function goTo(id, { remember = true } = {}) {
    if (!story.byId.has(id)) return;
    if (remember && currentId && currentId !== id) history.push(currentId);
    currentId = id;
    visited.add(id);
    render();
}

function goBack() {
    if (history.length === 0) return false;
    currentId = history.pop();
    render();
    return true;
}

function restart() {
    history = [];
    goTo(story.start, { remember: false });
}

const node = () => story.byId.get(currentId);
const choices = () => choicesOf(story, currentId);

// --- modes ---

const MODES = ['map', 'read', 'voice'];

function mode() {
    const m = location.hash.replace('#', '');
    return MODES.includes(m) ? m : 'read';
}

function render() {
    const m = mode();
    for (const name of MODES) $(`${name}-view`).hidden = name !== m;
    for (const a of document.querySelectorAll('.tabs a')) {
        if (a.dataset.mode === m) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
    if (!story) return;
    document.title = `${story.title} · StoryNode`;
    if (m === 'map') renderMap();
    if (m === 'read') renderRead();
    if (m === 'voice') renderVoice();
}

// --- map ---

function shorten(title, max = 24) {
    return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function renderMap() {
    $('map-title').textContent = story.title;
    const layout = layoutGraph(story);
    const svg = $('map');
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow' }));
    defs.append(marker);

    const edges = layout.edges.map(({ x1, y1, x2, y2 }) => {
        const mid = (y1 + y2) / 2;
        return svgEl('path', { class: 'edge', d: `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2 - 2}`, 'marker-end': 'url(#arrow)' });
    });

    const nodes = layout.nodes.map((box) => {
        const classes = ['node'];
        if (box.id === currentId) classes.push('current');
        else if (visited.has(box.id)) classes.push('visited');
        if (isEnding(story, box.id)) classes.push('ending');
        const g = svgEl('g', { class: classes.join(' '), tabindex: 0, role: 'button', 'aria-label': box.title });
        const title = svgEl('title');
        title.textContent = box.title;
        const rect = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h });
        const text = svgEl('text', { x: box.x + box.w / 2, y: box.y + box.h / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        text.textContent = shorten(box.title);
        g.append(title, rect, text);
        const open = () => {
            goTo(box.id);
            location.hash = '#read';
        };
        g.addEventListener('click', open);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
        return g;
    });

    svg.replaceChildren(defs, ...edges, ...nodes);
    // Keep the current node in view.
    const current = layout.nodes.find(b => b.id === currentId);
    if (current) {
        const scroller = svg.parentElement;
        scroller.scrollLeft = Math.max(0, current.x + current.w / 2 - scroller.clientWidth / 2);
    }
}

// --- read ---

function renderRead() {
    const n = node();
    $('read-title').textContent = n.title;
    $('read-text').replaceChildren(...n.text.split(/\n{2,}/).map(p => el('p', {}, p)));
    const list = choices();
    $('read-choices').replaceChildren(...list.map((c, i) => {
        const li = el('li');
        const b = el('button');
        b.append(el('span', { class: 'num' }, `${i + 1}.`), c.title);
        b.addEventListener('click', () => {
            goTo(c.id);
            window.scrollTo(0, 0);
        });
        li.append(b);
        return li;
    }));
    $('read-end').hidden = list.length > 0;
    $('read-back').disabled = history.length === 0;
}

// --- voice ---
//
// A small loop: read the page, read the choices, listen, act, repeat. `run`
// is bumped whenever the user taps or leaves voice mode, so an older loop
// that's still awaiting speech stops quietly instead of talking over.

const voice = { state: 'idle', run: 0, listening: null, retries: 0, started: false };

function setVoiceState(state, status = '') {
    voice.state = state;
    const talk = $('talk');
    talk.classList.toggle('listening', state === 'listening');
    talk.classList.toggle('reading', state === 'reading');
    talk.textContent = state === 'listening' ? 'Listening…'
        : state === 'reading' ? 'Tap to answer'
            : voice.started ? 'Tap to talk' : 'Start';
    $('voice-status').textContent = status;
}

function renderVoice() {
    const n = node();
    $('voice-title').textContent = n.title;
    const list = choices();
    // The choices are always tappable too: a fallback, and handy on a desk.
    $('voice-choices').replaceChildren(...list.map((c, i) => {
        const li = el('li');
        const b = el('button', {}, `${i + 1}. ${c.title}`);
        b.addEventListener('click', () => {
            stopVoice();
            goTo(c.id);
            voiceLoop(++voice.run);
        });
        li.append(b);
        return li;
    }));
    if (voice.state === 'idle') setVoiceState('idle', voice.started ? '' : 'Tap Start, then listen. Answer out loud when it asks.');
}

function stopVoice() {
    voice.run++;
    speaker.cancel();
    voice.listening?.abort();
    voice.listening = null;
}

async function say(text, run) {
    setVoiceState('reading', voice.state === 'listening' ? '' : $('voice-status').textContent);
    const done = await speaker.speak(text);
    return done && run === voice.run;
}

// Reads the page and the choices, then listens.
async function voiceLoop(run, { skipPage = false } = {}) {
    voice.started = true;
    voice.retries = 0;
    $('voice-heard').textContent = '';
    if (!skipPage) {
        setVoiceState('reading', 'Reading…');
        if (!(await say(pageScript(node()), run))) return;
    }
    setVoiceState('reading', 'Your choices…');
    if (!(await say(choicesScript(choices()), run))) return;
    if ($('voice-auto').checked) listen(run);
    else setVoiceState('idle', 'Tap to answer.');
}

async function listen(run) {
    if (!can.listen) {
        setVoiceState('idle', "This browser can't listen. Tap a choice below, or try Chrome or Safari.");
        return;
    }
    const list = choices();
    setVoiceState('listening', 'Listening…');
    voice.listening = listenOnce({ phrases: hintPhrases(list) });
    const { alternatives, error } = await voice.listening.promise;
    voice.listening = null;
    if (run !== voice.run) return;

    if (error === 'not-allowed' || error === 'service-not-allowed') {
        setVoiceState('idle', 'The microphone is blocked. Allow it for this page, then tap.');
        return;
    }
    $('voice-heard').textContent = alternatives[0] ? `Heard: “${alternatives[0]}”` : '';
    const result = match(alternatives, list);

    if (result.kind === 'choice') {
        const picked = $('voice-choices').children[result.index]?.querySelector('button');
        picked?.classList.add('picked');
        goTo(result.id);
        voiceLoop(run);
        return;
    }
    if (result.kind === 'command') {
        await command(result.name, run);
        return;
    }
    // Didn't catch it.
    voice.retries++;
    if (voice.retries > MAX_RETRIES) {
        setVoiceState('idle', 'Tap to try again.');
        return;
    }
    if (!(await say(retryScript(voice.retries), run))) return;
    if (voice.retries < MAX_RETRIES) listen(run);
    else setVoiceState('idle', 'Tap to try again.');
}

async function command(name, run) {
    switch (name) {
        case 'repeat':
            return voiceLoop(run);
        case 'choices':
            return voiceLoop(run, { skipPage: true });
        case 'back':
            if (!goBack()) {
                if (!(await say("You're at the beginning.", run))) return;
                return listen(run);
            }
            return voiceLoop(run);
        case 'restart':
            restart();
            return voiceLoop(run);
        case 'help':
            if (!(await say(HELP_SCRIPT, run))) return;
            return listen(run);
        case 'stop':
        default:
            stopVoice();
            setVoiceState('idle', 'Paused. Tap to carry on.');
    }
}

// The one button. Idle: start (or carry on). Reading: skip to answering.
// Listening: stop listening.
function onTalk() {
    const state = voice.state;
    stopVoice();
    const run = voice.run;
    if (state === 'listening') {
        setVoiceState('idle', 'Tap to talk.');
    } else if (state === 'reading') {
        listen(run);
    } else if (!voice.started) {
        voiceLoop(run);
    } else {
        listen(run);
    }
}

function setUpVoiceSettings() {
    const saved = readJson(VOICE_KEY) ?? {};
    const select = $('voice-select');
    const fill = () => {
        const voices = rankVoices(speaker.voices());
        if (voices.length === 0) return;
        const chosen = voices.find(v => v.name === saved.name) ?? voices[0];
        select.replaceChildren(...voices.map(v => new Option(`${v.name} (${v.lang})`, v.name, false, v === chosen)));
        speaker.setVoice(chosen);
    };
    fill();
    if (globalThis.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', fill);
    const save = () => writeJson(VOICE_KEY, { name: select.value, rate: Number($('voice-rate').value), auto: $('voice-auto').checked });
    select.addEventListener('change', () => {
        speaker.setVoice(speaker.voices().find(v => v.name === select.value) ?? null);
        save();
    });
    $('voice-rate').value = saved.rate ?? 1;
    speaker.setRate(Number($('voice-rate').value));
    $('voice-rate').addEventListener('input', () => {
        speaker.setRate(Number($('voice-rate').value));
        save();
    });
    $('voice-auto').checked = saved.auto ?? true;
    $('voice-auto').addEventListener('change', save);

    $('voice-support').textContent = [
        can.speak ? 'Reading aloud: yes.' : "Reading aloud: this browser can't.",
        can.listen ? 'Listening: yes.' : "Listening: this browser can't (try Chrome or Safari).",
        can.hints ? 'Choice hints: yes.' : 'Choice hints: not in this browser (matching still works).',
    ].join(' ');
}

// --- story dialog ---

function setUpStoryDialog() {
    const dialog = $('story-dialog');
    const showErrors = (errors) => {
        $('story-errors').textContent = errors.join('\n');
        $('story-errors').hidden = errors.length === 0;
    };
    $('story-button').addEventListener('click', () => {
        $('dialog-title').textContent = story?.title ?? 'Story';
        showErrors([]);
        dialog.showModal();
    });
    $('story-close').addEventListener('click', () => dialog.close());
    $('story-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (error) {
            showErrors([`That isn't valid JSON: ${error.message}`]);
            return;
        }
        const errors = useStory(data);
        if (errors.length) {
            showErrors(errors);
            return;
        }
        writeJson(STORY_KEY, data);
        dialog.close();
    });
    $('story-sample').addEventListener('click', async () => {
        writeJson(STORY_KEY, null);
        await loadSample();
        dialog.close();
    });
}

async function loadSample() {
    const response = await fetch(SAMPLE_URL);
    return useStory(await response.json());
}

// --- boot ---

async function boot() {
    setUpVoiceSettings();
    setUpStoryDialog();
    $('talk').addEventListener('click', onTalk);
    $('read-back').addEventListener('click', goBack);
    $('read-restart').addEventListener('click', restart);
    window.addEventListener('hashchange', () => {
        if (mode() !== 'voice') {
            stopVoice();
            setVoiceState('idle');
        }
        render();
    });

    const saved = readJson(STORY_KEY);
    const errors = saved ? useStory(saved) : [];
    if (!saved || errors.length) {
        try {
            await loadSample();
        } catch (error) {
            document.querySelector('main').prepend(el('p', { class: 'errors' }, `Couldn't load the sample story: ${error.message}. Serve this folder over http (see README).`));
        }
    }
    render();
}

boot();
