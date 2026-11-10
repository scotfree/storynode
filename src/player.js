// Plays audio clips ({ samples: Float32Array, sampleRate }) through Web Audio.
// One at a time. The browser side of clipspeaker.js.

export function createPlayer({ AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
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

        // Resolves true when the clip has played, false if stopped or it couldn't play.
        play({ samples, sampleRate }) {
            return new Promise((resolve) => {
                try {
                    const c = audio();
                    if (c.state !== 'running') {
                        // Never unlocked: a clip started now would never end.
                        resolve(false);
                        return;
                    }
                    const buffer = c.createBuffer(1, samples.length, sampleRate);
                    buffer.copyToChannel(samples, 0);
                    const source = c.createBufferSource();
                    source.buffer = buffer;
                    source.connect(c.destination);
                    const mine = { source, done: false };
                    mine.finish = (ok) => {
                        if (mine.done) return;
                        mine.done = true;
                        if (playing === mine) playing = null;
                        resolve(ok);
                    };
                    source.onended = () => mine.finish(true);
                    playing = mine;
                    source.start();
                } catch {
                    resolve(false);
                }
            });
        },

        stop() {
            const mine = playing;
            if (!mine) return;
            playing = null;
            mine.finish(false);
            try {
                mine.source.stop();
            } catch {
                // Already over.
            }
        },
    };
}
