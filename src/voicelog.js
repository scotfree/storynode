// The voice log: what the recognizer did and why a choice was picked. Pure,
// so the wording is easy to test. app.js shows it in a popup.

export function createLog({ cap = 500, now = Date.now } = {}) {
    const entries = [];
    return {
        add(kind, text) {
            entries.push({ t: now(), kind, text });
            if (entries.length > cap) entries.shift();
        },
        entries: () => entries,
    };
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

function clock(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export const formatEntry = (entry) => `${clock(entry.t)}  ${entry.kind}  ${entry.text}`;

// One line per guess tried, explaining the matcher's decision on it.
export function matchLines(result) {
    return result.trace.map(({ said, number, command, scores, outcome }) => {
        const parts = [`number: ${number ?? 'none'}`, `command: ${command ?? 'none'}`];
        if (scores.length) {
            parts.push(`titles: ${scores.map((s, i) => `${i + 1}=${s.distinct}/${s.hits}`).join(' ')} (unique/total)`);
        }
        return `“${said}”  ${parts.join(', ')}  → ${outcome}`;
    });
}
