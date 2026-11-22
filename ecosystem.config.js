module.exports = {
    apps: [
        {
            name: 'noppo-agent',
            script: 'index.js',
            cwd: __dirname,
            interpreter: 'node',
            autorestart: true,
            max_restarts: 20,
            restart_delay: 5000,
            max_memory_restart: '900M',
            time: true,
            merge_logs: true,
            out_file: 'logs/noppo.out.log',
            error_file: 'logs/noppo.err.log',
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
