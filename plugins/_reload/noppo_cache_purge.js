'use strict';







const path = require('path');

const targets = ['noppo_config.js', 'noppo_commands.js', 'noppo_sessions.js', 'noppo_context.js', 'noppo_delivery.js']
    .map(name => path.join(__dirname, '..', '..', 'lib', name));

let purged = 0;

for (const file of targets) {
    try {
        const resolved = require.resolve(file);
        if (require.cache[resolved]) {
            delete require.cache[resolved];
            purged += 1;
        }
    } catch (error) {
        console.error('[NOPPO CACHE] gagal purge', file, error.message);
    }
}

console.log(`[NOPPO CACHE] purged ${purged}/${targets.length} modul Noppo`);

module.exports = { name: 'noppo-cache-purge' };
