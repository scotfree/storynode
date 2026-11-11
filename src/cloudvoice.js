// A voice from a speech service: each sentence is sent to OpenAI's speech API
// and comes back as audio. A clip source for clipspeaker.js, like the model.
//
// There's no server here, so the listener brings their own API key. It is
// kept in this browser only and sent nowhere but the service. Fine for one
// person; a public site would need a small proxy that holds the key instead.
//
// Pure: fetch is passed in, so it's tested in Node.

import { clipStats } from './modelvoice.js';

export const CLOUD = {
    url: 'https://api.openai.com/v1/audio/speech',
    model: 'gpt-4o-mini-tts',
    sampleRate: 24000,          // what its "pcm" format is: 24 kHz, 16-bit, mono
    // This model takes direction in plain words. Two roles, two directions:
    // the story's own words, and the app speaking for itself.
    instructions: 'Read this aloud as a warm, unhurried storyteller narrating an adventure to one listener. '
        + 'Keep the same voice and pace from line to line.',
    appInstructions: 'Say this plainly and briskly, as a friendly guide giving a short prompt or instruction. '
        + 'Keep the same voice and pace from line to line.',
    voices: { story: 'marin', app: 'cedar' },
    dollarsPerThousandCharacters: 0.015,    // an estimate; it is billed by audio length
};

export const CLOUD_VOICES = [
    { id: 'marin', name: 'Marin' },
    { id: 'cedar', name: 'Cedar' },
    { id: 'coral', name: 'Coral' },
    { id: 'sage', name: 'Sage' },
    { id: 'ash', name: 'Ash' },
    { id: 'ballad', name: 'Ballad' },
    { id: 'verse', name: 'Verse' },
    { id: 'fable', name: 'Fable' },
    { id: 'onyx', name: 'Onyx' },
    { id: 'nova', name: 'Nova' },
    { id: 'alloy', name: 'Alloy' },
    { id: 'echo', name: 'Echo' },
    { id: 'shimmer', name: 'Shimmer' },
];

const CACHE_SIZE = 200;
const AT_ONCE = 3;      // requests in flight; the rest wait, so a cancelled page isn't all paid for

// Raw 16-bit little-endian samples → the floats Web Audio plays.
export function pcm16ToFloat32(buffer) {
    const view = new DataView(buffer);
    const samples = new Float32Array(Math.floor(view.byteLength / 2));
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return samples;
}

// "about 3,900 characters sent from this browser, roughly $0.06"
export function costNote(characters) {
    if (!characters) return 'Nothing sent from this browser yet.';
    const dollars = characters / 1000 * CLOUD.dollarsPerThousandCharacters;
    const cost = dollars < 0.01 ? 'under a cent' : `roughly $${dollars.toFixed(2)}`;
    return `${characters.toLocaleString('en-US')} characters sent from this browser so far, ${cost}.`;
}

// What went wrong, in words, and whether to stop asking until the key changes.
export function cloudError(status, body) {
    const detail = body?.error?.message ? ` (${body.error.message})` : '';
    if (status === 401) return { stop: true, message: `The key was refused${detail}` };
    if (status === 403) return { stop: true, message: `The key isn't allowed to do this${detail}` };
    if (status === 429 && body?.error?.code === 'insufficient_quota') {
        return { stop: true, message: 'The account is out of credit' };
    }
    if (status === 429) return { stop: false, message: 'Too many requests just now' };
    return { stop: false, message: `The service answered ${status}${detail}` };
}

// One line for the settings panel.
export function cloudNote(state) {
    if (state.status === 'no-key') return 'Paste an OpenAI API key to use this voice. Until then the browser voice reads.';
    if (state.status === 'failed') return `${state.error}. Using the browser voice.`;
    return costNote(state.characters);
}

// onChange(state): { status: 'no-key' | 'ready' | 'failed', error, characters }
// onClip({ text, seconds, took, peak, ok, error }) after each sentence.
export function createCloudVoice({
    fetch = globalThis.fetch?.bind(globalThis),
    characters = 0,
    onChange = () => {},
    onClip = () => {},
    now = () => Date.now(),
} = {}) {
    let key = '';
    let voices = { ...CLOUD.voices };
    let stopped = null;         // why it gave up on this key, if it has
    let sent = characters;
    let running = 0;
    let queue = [];             // requests not started: { key, text, speed, waiters }
    const pending = new Map();  // cache key → request, started or not
    const cache = new Map();

    const state = () => ({
        status: !key ? 'no-key' : stopped ? 'failed' : 'ready',
        error: stopped,
        characters: sent,
    });
    const changed = () => onChange(state());

    const settle = (request, clip) => {
        pending.delete(request.key);
        request.waiters.splice(0).forEach(resolve => resolve(clip));
    };

    async function make(request) {
        const startedAt = now();
        const report = (extra) => onClip({ text: request.text, took: (now() - startedAt) / 1000, seconds: 0, peak: 0, ok: false, ...extra });
        try {
            const response = await fetch(CLOUD.url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: CLOUD.model,
                    voice: request.voice,
                    input: request.text,
                    instructions: request.role === 'app' ? CLOUD.appInstructions : CLOUD.instructions,
                    response_format: 'pcm',
                    ...(request.speed === 1 ? {} : { speed: request.speed }),
                }),
            });
            if (!response.ok) {
                const { stop, message } = cloudError(response.status, await response.json().catch(() => null));
                if (stop && request.apiKey === key) stopped = message;
                report({ error: message });
                return null;
            }
            const clip = { samples: pcm16ToFloat32(await response.arrayBuffer()), sampleRate: CLOUD.sampleRate };
            sent += request.text.length;
            const stats = clipStats(clip);
            report({ ...stats, error: stats.ok ? null : 'the audio came back silent' });
            return stats.ok ? clip : null;
        } catch (error) {
            report({ error: `couldn't reach the service (${error?.message ?? error})` });
            return null;
        }
    }

    function pump() {
        while (running < AT_ONCE && queue.length) {
            const request = queue.shift();
            running++;
            make(request).then((clip) => {
                running--;
                if (clip) {
                    cache.set(request.key, clip);
                    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
                }
                settle(request, clip);
                changed();
                if (stopped) dropAll();
                pump();
            });
        }
    }

    function dropAll() {
        for (const request of queue.splice(0)) settle(request, null);
        for (const request of pending.values()) request.waiters.splice(0).forEach(resolve => resolve(null));
    }

    return {
        state,
        // One voice for the story's words and one for the app's.
        setVoices(chosen) { voices = { ...voices, ...chosen }; },

        // A new key gets a fresh start.
        setKey(value) {
            key = String(value ?? '').trim();
            stopped = null;
            dropAll();
            changed();
        },

        // A clip for one sentence, or null if the service can't be used.
        // `role` is 'story' (the default) or 'app'.
        clip(text, { rate = 1, role = 'story' } = {}) {
            if (!key || stopped) return Promise.resolve(null);
            const speed = Math.round(rate * 100) / 100;
            const part = role === 'app' ? 'app' : 'story';
            const voice = voices[part];
            const cacheKey = `${part}|${voice}|${speed}|${text}`;
            if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey));
            return new Promise((resolve) => {
                const same = pending.get(cacheKey);
                if (same) {
                    same.waiters.push(resolve);
                    return;
                }
                const request = { key: cacheKey, apiKey: key, text, voice, role: part, speed, waiters: [resolve] };
                pending.set(cacheKey, request);
                queue.push(request);
                pump();
            });
        },

        // Nobody's waiting any more: what hasn't been sent isn't, and what
        // has been is kept when it arrives, since it's paid for.
        drop: dropAll,
    };
}
