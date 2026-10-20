import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The login page (login/login.html, .css, .js) plus the small logout script
 * shared by the two dashboard views (shared/session.js). Plain static files
 * read once at startup, like dashboard-page.ts; external <script>/<link> tags
 * only, so helmet's default CSP needs no changes. The Dockerfile copies
 * ui/login (ui/shared is already copied).
 */
const dir = join(__dirname, 'login');

export const loginHtml = readFileSync(join(dir, 'login.html'), 'utf-8');
export const loginCss = readFileSync(join(dir, 'login.css'), 'utf-8');
export const loginJs = readFileSync(join(dir, 'login.js'), 'utf-8');
export const sessionJs = readFileSync(join(__dirname, 'shared', 'session.js'), 'utf-8');
