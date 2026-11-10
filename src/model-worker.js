// Runs the Kokoro voice model off the main thread. See modelvoice.js.
//
// The library and the model come from outside the first time they're wanted
// and are then cached by the browser: the code from jsDelivr, the model and
// voices from Hugging Face. This is the one place the app loads anything
// that isn't in this folder.

const LIBRARY = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;

async function hasWebGpu() {
    try {
        return Boolean(await navigator.gpu?.requestAdapter());
    } catch {
        return false;
    }
}

async function load({ dtype, device }) {
    const { KokoroTTS } = await import(LIBRARY);
    const progress_callback = (p) => {
        if (p.status === 'progress' && p.total) postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    };
    let use = device === 'webgpu' && !(await hasWebGpu()) ? 'wasm' : device;
    try {
        tts = await KokoroTTS.from_pretrained(MODEL, { dtype, device: use, progress_callback });
    } catch (error) {
        if (use !== 'webgpu') throw error;
        use = 'wasm';
        tts = await KokoroTTS.from_pretrained(MODEL, { dtype, device: use, progress_callback });
    }
    postMessage({ type: 'ready', device: use });
}

self.onmessage = async ({ data }) => {
    if (data.type === 'load') {
        try {
            await load(data);
        } catch (error) {
            postMessage({ type: 'error', message: error?.message ?? String(error) });
        }
        return;
    }
    if (data.type === 'speak') {
        try {
            const audio = await tts.generate(data.text, { voice: data.voice, speed: data.speed });
            const samples = audio.audio;
            postMessage({ type: 'audio', id: data.id, samples, sampleRate: audio.sampling_rate }, [samples.buffer]);
        } catch (error) {
            postMessage({ type: 'failed', id: data.id, message: error?.message ?? String(error) });
        }
    }
};
