// Playwright fixture entry (external: the server's CSP blocks inline scripts).
import * as checks from './checks.js';
window.checks = checks;
window.__ready = true;
