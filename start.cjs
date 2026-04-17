// CJS wrapper for cPanel's LiteSpeed Node runner (lsnode.js)
// lsnode uses require() which can't load ESM directly
const path = require('path');
process.chdir(__dirname);
import('./server.js').catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
