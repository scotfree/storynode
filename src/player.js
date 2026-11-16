// Plays audio clips ({ samples: Float32Array, sampleRate }) one at a time,
// through Web Audio. The browser side of clipspeaker.js.
//
// For a short while clips went through an <audio> element instead. On an
// iPhone that put the page's audio into media playback, which then fought
// with the microphone: the sound dropped in volume and recognition stopped
// hearing anything after an answer or two. Web Audio doesn't do that. Its
// one cost there: the iPhone's silent switch mutes it (not the browser voice).

const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
const SLACK_MS = 3000;      // a clip that hasn't ended this long after it should have is stuck

// onEvent(name, detail) reports what happened to each clip, for the voice log:
// 'played', 'blocked' (sound isn't allowed yet), 'failed', 'stuck'.
export function createPlayer({
    AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
    onEvent = () => {},
    timers = realTimers,
    now = () => Date.now(),
} = {}) {
    let context = null;
    let playing = null;

    const audio = () => {
        context ??= new AudioContextClass();
        return context;
    };

    return {
        // Call from a tap: Safari keeps audio suspended until a gesture starts some.
        unlock() {
            try {
                const c = audio();
                c.resume();
                const blip = c.createBufferSource();
                blip.buffer = c.createBuffer(1, 1, 22050);
                blip.connect(c.destination);
                blip.start(0);
            } catch {
                // No audio here; play() will say so.
            }
        },

        // Resolves true when the clip has played, false if stopped or it
        // couldn't play (the caller then reads that sentence another way).
        play({ samples, sampleRate }) {
            return new Promise((resolve) => {
                const seconds = samples.length / sampleRate;
                let c;
                let source;
                try {
                    c = audio();
                    if (c.state !== 'running') {
                        // Never unlocked: a clip started now would never end.
                        onEvent('blocked', `sound is ${c.state}: tap the button to allow it`);
                        resolve(false);
                        return;
                    }
                    const buffer = c.createBuffer(1, samples.length, sampleRate);
                    buffer.copyToChannel(samples, 0);
                    source = c.createBufferSource();
                    source.buffer = buffer;
                    source.connect(c.destination);
                } catch (error) {
                    onEvent('failed', error?.name ?? 'no audio');
                    resolve(false);
                    return;
                }
                const started = now();
                const mine = { source, done: false };
                const finish = (ok, event, detail) => {
                    if (mine.done) return;
                    mine.done = true;
                    timers.clear(mine.timer);
                    source.onended = null;
                    if (playing === mine) playing = null;
                    if (event) onEvent(event, detail);
                    resolve(ok);
                };
                mine.finish = finish;
                playing = mine;
                source.onended = () => finish(true, 'played', `${seconds.toFixed(1)} s clip, ended after ${((now() - started) / 1000).toFixed(1)} s`);
                // If it never ends, give up so the sentence is read another way.
                mine.timer = timers.set(() => {
                    try {
                        source.stop();
                    } catch {
                        // Never started.
                    }
                    finish(false, 'stuck', `${seconds.toFixed(1)} s clip still playing after ${((now() - started) / 1000).toFixed(1)} s`);
                }, seconds * 1000 + SLACK_MS);
                try {
                    source.start();
                } catch (error) {
                    finish(false, 'failed', error?.name ?? 'start failed');
                }
            });
        },

        // 'running' once a tap has allowed audio; 'suspended' or 'none' before.
        state: () => context?.state ?? 'none',

        stop() {
            const mine = playing;
            if (!mine) return;
            mine.finish(false);
            try {
                mine.source.stop();
            } catch {
                // Already over.
            }
        },
    };
}
