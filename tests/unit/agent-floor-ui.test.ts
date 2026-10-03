import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// CAF-DASHBOARD-02 T4: the Agent Floor page and its static files — same
// Basic Auth as the dashboard, sets the SSE cookie, no build step, and
// nothing that helmet's default CSP (`script-src 'self'`) would block.

const configMock = {
  dashboard: { enabled: true, basicAuthUser: 'admin' },
  DASHBOARD_BASIC_AUTH_PASSWORD: 'correct-horse',
};

vi.mock('../../src/config/index.js', () => ({
  get config() {
    return configMock;
  },
}));

const UI_DIR = join(__dirname, '../../src/presentation/web/ui');
const ASSETS = ['app.css', 'render.js', 'translate.js', 'demo.js', 'adapter.js'];
const authHeader = { authorization: `Basic ${Buffer.from('admin:correct-horse').toString('base64')}` };

describe('Agent Floor UI routes', () => {
  async function buildTestApp() {
    const Fastify = (await import('fastify')).default;
    const { agentFloorUiRoutes } = await import('../../src/presentation/web/routes/agent-floor-ui.js');
    const app = Fastify();
    await app.register(agentFloorUiRoutes);
    return app;
  }

  it('rejects the page and every asset without auth (401), and sets no cookie', async () => {
    const app = await buildTestApp();

    for (const url of ['/dashboard/agent-floor', ...ASSETS.map((a) => `/dashboard/agent-floor/${a}`)]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    }

    await app.close();
  });

  it('serves the page and sets the same SSE auth cookie /dashboard sets', async () => {
    const app = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/dashboard/agent-floor', headers: authHeader });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(String(response.headers['set-cookie'])).toBe(
      `caf_dashboard_auth=${Buffer.from('admin:correct-horse').toString('base64')}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=3600`,
    );
    expect(response.body).toContain('CAF Agent Floor');

    await app.close();
  });

  it('serves the same page for the demo URL (the mode is decided in the browser)', async () => {
    const app = await buildTestApp();
    const live = await app.inject({ method: 'GET', url: '/dashboard/agent-floor', headers: authHeader });
    const demo = await app.inject({ method: 'GET', url: '/dashboard/agent-floor?demo=1', headers: authHeader });
    expect(demo.statusCode).toBe(200);
    expect(demo.body).toBe(live.body);
    await app.close();
  });

  it('serves every file the page references, with the right content type', async () => {
    const app = await buildTestApp();
    const page = (await app.inject({ method: 'GET', url: '/dashboard/agent-floor', headers: authHeader })).body;

    const local = [...page.matchAll(/(?:src|href)="(\/dashboard\/agent-floor\/[^"?]+)"/g)].map((m) => m[1]);
    expect(local.sort()).toEqual(ASSETS.map((a) => `/dashboard/agent-floor/${a}`).sort());

    for (const url of local) {
      const response = await app.inject({ method: 'GET', url, headers: authHeader });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toContain(url.endsWith('.css') ? 'text/css' : 'javascript');
      expect(response.body.length, url).toBeGreaterThan(100);
    }

    await app.close();
  });

  it('is not registered at all when the dashboard is disabled', async () => {
    configMock.dashboard.enabled = false;
    try {
      const app = await buildTestApp();
      expect((await app.inject({ method: 'GET', url: '/dashboard/agent-floor', headers: authHeader })).statusCode).toBe(404);
      await app.close();
    } finally {
      configMock.dashboard.enabled = true;
    }
  });
});

describe('Agent Floor static files', () => {
  const html = readFileSync(join(UI_DIR, 'agent-floor/agent-floor.html'), 'utf-8');
  const read = (name: string): string => readFileSync(join(UI_DIR, 'agent-floor', name), 'utf-8');

  it('has no inline script, inline event handler, or embedded base64 logo (CSP-safe, uses the project logo)', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).not.toContain('base64');
    expect(html).toContain('src="/dashboard/logo.png"');
  });

  it('keeps the accessibility hooks from the approved prototype', () => {
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="conn" role="status"');
  });

  it('is read-only: no pipeline controls, and the adapter only ever issues GET requests', () => {
    expect(html).not.toMatch(/approve|retry-pipeline|>\s*(Stop|Retry|Approve)\s*</i);
    const adapter = read('adapter.js');
    expect(adapter).not.toMatch(/method\s*:/);
    expect(adapter).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(adapter).not.toContain('sendBeacon');
  });

  it('only the adapter talks to the server — render, translate and demo never fetch', () => {
    for (const name of ['render.js', 'translate.js', 'demo.js']) {
      expect(read(name), name).not.toMatch(/\bfetch\(|EventSource|XMLHttpRequest/);
    }
    expect(read('adapter.js')).toContain("new EventSource('/api/events/stream')");
  });

  it('agents stay seated: typing while working, coffee while idle, Docs on the pantry sofa without a desk', () => {
    const render = read('render.js');
    expect(render).toContain("else if(WORKING[st])pose='type';");
    expect(render).toContain("else if(st==='idle'&&a.id!=='human')pose='coffee';");
    expect(render).toContain("ORDER.forEach(function(id){if(id!=='docs')drawDesk(id,T);});");
    // Docs is never given a working pose or state by the page itself.
    expect(render).toContain("a.state=(id==='docs')?'offduty':'idle'");
  });

  it('the page is in English: declared language, and no Indonesian UI text left in any file', () => {
    expect(html).toContain('<html lang="en">');
    const leftover =
      /\b(berjalan|belum|tidak|sedang|kejadian|menunggu|percobaan|biaya|jeda|lanjut|selesai|dengan|untuk|yang|hanya|lolos|gagal|siap|tiket|dibuka|menolak|butuh|contoh|skenario)\b/i;
    for (const name of ['agent-floor.html', 'agent-floor.css', 'render.js', 'translate.js', 'demo.js', 'adapter.js']) {
      expect(read(name).match(leftover)?.[0], name).toBeUndefined();
    }
  });

  it('render exposes the prototype entry points, and demo/adapter go through them', () => {
    const render = read('render.js');
    for (const fn of ['setState', 'say', 'sendDoc', 'step', 'setStatus', 'log']) {
      expect(render).toMatch(new RegExp(`\\b${fn}:${fn}\\b`));
    }
    // The mock scenarios moved to demo.js, not deleted (FR-7).
    expect(render).not.toContain('var SCEN=');
    expect(read('demo.js')).toContain('var SCEN=');
  });

  describe('T7: accessibility and performance guards', () => {
    it('never polls: no interval timers anywhere, and the only timers are a debounce and the live gap', () => {
      for (const name of ['render.js', 'translate.js', 'demo.js', 'adapter.js']) {
        expect(read(name), name).not.toContain('setInterval');
      }
      for (const name of ['render.js', 'translate.js', 'demo.js']) {
        expect(read(name), name).not.toContain('setTimeout');
      }
      // adapter.js: one debounce for the run list, one real-time gap between live events.
      expect(read('adapter.js').match(/setTimeout\(/g)).toHaveLength(2);
    });

    it('nothing in the per-frame path touches the network (render is driven by requestAnimationFrame only)', () => {
      const render = read('render.js');
      expect(render).toContain('requestAnimationFrame(frame)');
      expect(render).not.toMatch(/\bfetch\(|EventSource/);
    });

    it('honours prefers-reduced-motion: starts paused, CSS animations off, and no state depends on movement', () => {
      const render = read('render.js');
      expect(render).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
      // Agents never walk: each has one fixed seat, so a paused page still shows the true state.
      expect(render).toContain('function placeInitial(a){a.x=ST[a.id].cx;a.y=ST[a.id].fy;}');
      expect(render).not.toMatch(/goTo\(|stepAgent|PANTRY/);
      expect(read('agent-floor.css')).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none/);
      // Live data must keep arriving while paused: the live gap waits on real time, not simulation time.
      expect(read('adapter.js')).toContain('item.live?realDelay(item.delay):AF.wait(item.delay)');
    });

    it('follows the system light/dark theme', () => {
      expect(read('agent-floor.css')).toContain('@media (prefers-color-scheme:dark)');
    });

    it('every agent is reachable from the keyboard through the status list, not only by clicking the canvas', () => {
      const render = read('render.js');
      // One real <button> per agent, built from the same ORDER the canvas draws.
      expect(render).toMatch(/ORDER\.forEach\(function\(id\)\{\s*var a=A\[id\],b=document\.createElement\('button'\);b\.type='button';b\.className='ar';/);
      expect(render).toContain("r.setAttribute('aria-pressed',id===selected?'true':'false')");
    });

    it('labels the live regions and the tab pattern for screen readers', () => {
      expect(html).toMatch(/<ul id="log" role="log" aria-live="polite">/);
      expect(html).toMatch(/id="rpill" aria-live="polite"/);
      expect(html).toMatch(/role="tablist" aria-label=/);
      expect(html).toMatch(/role="tab" id="tab-log" aria-selected="true" aria-controls="pane-log"/);
      expect(html).toMatch(/role="tabpanel" aria-labelledby="tab-ag" hidden/);
      expect(html).toMatch(/<canvas id="cv" role="img" aria-label="[^"]+">/);
      expect(html).toMatch(/id="pp" type="button" aria-pressed="false"/);
      expect(read('render.js')).toContain("ev.key!=='ArrowLeft'&&ev.key!=='ArrowRight'");
    });

    it('keeps scrolling inside the panels on desktop: the page itself is a fixed-height grid', () => {
      const css = read('agent-floor.css');
      expect(css).toContain('.app{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr)');
      expect(css).toContain('.pb{flex:1;min-height:0;overflow:auto');
    });
  });

  it('the existing dashboard links to the Agent Floor', () => {
    expect(readFileSync(join(UI_DIR, 'dashboard/dashboard.html'), 'utf-8')).toContain('href="/dashboard/agent-floor"');
  });
});
