// A neural voice that runs in the page: Kokoro (82M parameters, Apache 2.0)
// through kokoro-js. Free and private like the browser's voice, and better
// sounding, at the price of a big one-time download and slower starts.
//
// The model lives in a worker (model-worker.js) so the page stays smooth.
// This side asks it for one sentence at a time and hands back clips for
// clipspeaker.js. No DOM here; the worker is passed in, so it's tested in Node.

// Two builds of the same model. Small is 8-bit and runs on the CPU. Large is
// the full-precision one, for the GPU where the browser has WebGPU.
export const MODEL_SIZES = {
    small: { label: 'Small', dtype: 'q8', device: 'wasm', megabytes: 90 },
    large: { label: 'Large', dtype: 'fp32', device: 'webgpu', megabytes: 310 },
};

// The better-rated English voices (a = American, b = British; f/m).
export const MODEL_VOICES = [
    { id: 'af_heart', name: 'Heart (US, female)' },
    { id: 'af_bella', name: 'Bella (US, female)' },
    { id: 'af_nicole', name: 'Nicole (US, female, soft)' },
    { id: 'am_fenrir', name: 'Fenrir (US, male)' },
    { id: 'am_michael', name: 'Michael (US, male)' },
    { id: 'am_puck', name: 'Puck (US, male)' },
    { id: 'bf_emma', name: 'Emma (UK, female)' },
    { id: 'bm_george', name: 'George (UK, male)' },
    { id: 'bm_fable', name: 'Fable (UK, male)' },
];

const CACHE_SIZE = 80;      // clips kept, so Repeat doesn't generate again
const SILENT_PEAK = 0.001;  // a clip quieter than this is a failed one

// What a clip holds: how long it plays, and how loud it gets (0 to 1).
// A broken model gives silence or not-numbers, which is `ok: false`.
export function clipStats({ samples, sampleRate }) {
    let peak = 0;
    let bad = 0;
    for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i]);
        if (!Number.isFinite(v)) bad++;
        else if (v > peak) peak = v;
    }
    return { seconds: samples.length / sampleRate, peak, ok: bad === 0 && peak >= SILENT_PEAK };
}

// "2.3 s of audio in 6.6 s (2.9× slower than it plays)"
export function timingNote(seconds, took) {
    const base = `${seconds.toFixed(1)} s of audio in ${took.toFixed(1)} s`;
    if (seconds <= 0 || took <= 0) return base;
    const ratio = took / seconds;
    return ratio > 1.1 ? `${base} (${ratio.toFixed(1)}× slower than it plays)` : `${base} (faster than it plays)`;
}

// How far along a download is, from per-file { loaded, total } counts.
export function loadProgress(files) {
    const all = Object.values(files ?? {}).filter(f => f.total > 0);
    const loaded = all.reduce((sum, f) => sum + Math.min(f.loaded, f.total), 0);
    const total = all.reduce((sum, f) => sum + f.total, 0);
    return { loaded, total, fraction: total ? loaded / total : 0 };
}

const megabytes = (bytes) => Math.round(bytes / 1048576);

// One line for the settings panel.
export function modelNote(state) {
    const size = MODEL_SIZES[state.size];
    if (state.status === 'loading') {
        const { loaded, total, fraction } = loadProgress(state.files);
        if (total === 0) return `Getting the ${size.label.toLowerCase()} model (about ${size.megabytes} MB the first time)…`;
        if (fraction >= 1) return 'Starting the model…';
        return `Getting the model: ${megabytes(loaded)} of ${megabytes(total)} MB. The browser voice reads until it's ready.`;
    }
    if (state.status === 'ready') {
        return `Model ready, running on the ${state.device === 'webgpu' ? 'graphics chip' : 'processor'}. It's kept on this device.`;
    }
    if (state.status === 'failed') return `Couldn't load the model (${state.error}). Using the browser voice.`;
    return '';
}

// makeWorker() → a Worker-like { postMessage, terminate, onmessage, onerror }.
// onChange(state) is called whenever the state changes:
//   { status: 'off' | 'loading' | 'ready' | 'failed', size, files, device, error }
// onClip({ text, seconds, took, peak, ok, error }) after each sentence is made.
export function createModelVoice({ makeWorker, onChange = () => {}, onClip = () => {}, now = () => Date.now() }) {
    let worker = null;
    let state = { status: 'off', size: null, files: {}, device: null, error: null };
    let voice = MODEL_VOICES[0].id;
    let nextId = 0;
    let current = null;         // the request the worker is on: { id, key, text, speed, waiters }
    let queue = [];             // requests not sent yet
    const cache = new Map();    // key → clip

    const set = (patch) => {
        state = { ...state, ...patch };
        onChange(state);
    };

    const settle = (request, clip) => request.waiters.splice(0).forEach(resolve => resolve(clip));

    const pump = () => {
        if (current || queue.length === 0 || state.status !== 'ready') return;
        current = queue.shift();
        current.sentAt = now();
        worker.postMessage({ type: 'speak', id: current.id, text: current.text, voice: current.voice, speed: current.speed });
    };

    const onMessage = (msg) => {
        if (msg.type === 'progress') {
            set({ files: { ...state.files, [msg.file]: { loaded: msg.loaded, total: msg.total } } });
        } else if (msg.type === 'ready') {
            set({ status: 'ready', device: msg.device });
            pump();
        } else if (msg.type === 'error') {
            fail(msg.message);
        } else if ((msg.type === 'audio' || msg.type === 'failed') && current?.id === msg.id) {
            const done = current;
            current = null;
            let clip = msg.type === 'audio' ? { samples: msg.samples, sampleRate: msg.sampleRate } : null;
            const took = (now() - done.sentAt) / 1000;
            if (clip) {
                const stats = clipStats(clip);
                onClip({ text: done.text, took, ...stats, error: stats.ok ? null : 'the audio came out silent' });
                if (!stats.ok) clip = null;
            } else {
                onClip({ text: done.text, took, seconds: 0, peak: 0, ok: false, error: msg.message ?? 'failed' });
            }
            if (clip) {
                cache.set(done.key, clip);
                if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
            }
            settle(done, clip);
            pump();
        }
    };

    const stopWorker = () => {
        worker?.terminate();
        worker = null;
        for (const request of [current, ...queue]) if (request) settle(request, null);
        current = null;
        queue = [];
        cache.clear();
    };

    function fail(message) {
        stopWorker();
        set({ status: 'failed', error: String(message || 'unknown error') });
    }

    return {
        state: () => state,
        setVoice(id) { voice = id; },

        // Starts loading a size ('small' or 'large'), replacing any other.
        load(size) {
            if (state.size === size && (state.status === 'loading' || state.status === 'ready')) return;
            stopWorker();
            const mine = makeWorker();
            worker = mine;
            mine.onmessage = (e) => { if (worker === mine) onMessage(e.data); };
            mine.onerror = (e) => { if (worker === mine) fail(e?.message); };
            set({ status: 'loading', size, files: {}, device: null, error: null });
            const { dtype, device } = MODEL_SIZES[size];
            mine.postMessage({ type: 'load', dtype, device });
        },

        // Frees the model's memory. The download stays in the browser's cache.
        unload() {
            stopWorker();
            set({ status: 'off', size: null, files: {}, device: null, error: null });
        },

        // A clip for one sentence, or null if there's no model to make it.
        clip(text, { rate = 1 } = {}) {
            if (state.status !== 'ready') return Promise.resolve(null);
            const speed = Math.round(rate * 100) / 100;
            const key = `${voice}|${speed}|${text}`;
            if (cache.has(key)) return Promise.resolve(cache.get(key));
            return new Promise((resolve) => {
                const same = [current, ...queue].find(r => r?.key === key);
                if (same) {
                    same.waiters.push(resolve);
                    return;
                }
                queue.push({ id: ++nextId, key, text, voice, speed, waiters: [resolve] });
                pump();
            });
        },

        // Makes clips ahead of need, for sentences likely to be wanted soon.
        // They wait behind anything asked for properly, and drop() forgets them.
        warm(texts, { rate = 1 } = {}) {
            for (const text of texts) this.clip(text, { rate });
        },

        // Nobody's waiting any more. The sentence being generated can't be
        // stopped, so it finishes and is kept in case it's asked for again.
        drop() {
            for (const request of [current, ...queue]) if (request) settle(request, null);
            queue = [];
        },
    };
}
