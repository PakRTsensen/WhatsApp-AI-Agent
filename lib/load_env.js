'use strict';

const fs = require('fs');
const path = require('path');

const envFile = process.env.NOPPO_ENV_FILE || path.join(__dirname, '..', 'control', 'noppo.env');

function unquote(value) {
    const text = String(value || '').trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
    }
    return text;
}

try {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = unquote(trimmed.slice(eq + 1));
        if (key && process.env[key] === undefined) process.env[key] = value;
    }
} catch (_) {}

module.exports = { envFile };
