/**
 * Turn a live page into a compact, agent-facing element observation.
 *
 * The extraction runs inside the page. It keeps only elements a browser agent
 * could actually act on (visible, enabled, interactive), gives each a stable
 * CSS selector, and prunes the result to a candidate budget so the observation
 * stays small enough to hand to a decision model.
 *
 * The observation produced here is an *internal* representation. Callers of the
 * tools never receive it - see session.ts.
 *
 * Ported 1:1 from openjev/browser/observe.py.
 */

// Candidate selector: things a user could click, type into or choose.
export const CANDIDATE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=switch]',
  '[role=combobox]',
  '[role=searchbox]',
  '[role=textbox]',
  '[contenteditable=true]',
  '[onclick]',
].join(', ')

export interface ExtractArgs {
  selector: string
  maxCandidates: number
  maxNameLength: number
  includeOffscreen: boolean
}

// NOTE: this runs INSIDE the page (playwright serializes the function), so it
// must not close over module scope. Playwright's Node client treats string
// expressions as expressions (functions come out unserializable), which is
// why this is a real function and not the EXTRACT_JS string of the Python
// original. Keep the body in sync with openjev/browser/observe.py.
export function extractInPage(args: ExtractArgs): Record<string, unknown> {
  const { selector, maxCandidates, maxNameLength, includeOffscreen } = args;

  const collapse = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const cssEscape = (value: string) => (window.CSS && CSS.escape)
    ? CSS.escape(value)
    : String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

  function isVisible(el: any) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    return true;
  }

  function isDisabled(el: any) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  function inViewport(el: any) {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  function labelledBy(el: any) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return ids.map((id: string) => {
      const ref = document.getElementById(id);
      return ref ? collapse((ref as HTMLElement).innerText || ref.textContent) : '';
    }).filter(Boolean).join(' ');
  }

  function labelFor(el: any) {
    if (el.labels && el.labels.length) {
      return collapse([...el.labels].map((l: any) => l.innerText || l.textContent).join(' '));
    }
    const closest = el.closest('label');
    return closest ? collapse((closest as HTMLElement).innerText || closest.textContent) : '';
  }

  function accessibleName(el: any): string {
    const aria = collapse(el.getAttribute('aria-label'));
    if (aria) return aria;
    const by = labelledBy(el);
    if (by) return by;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const lab = labelFor(el);
      if (lab) return lab;
      const ph = collapse(el.getAttribute('placeholder'));
      if (ph) return ph;
      const alt = collapse(el.getAttribute('alt'));
      if (alt) return alt;
      const name = collapse(el.getAttribute('name'));
      if (name) return name;
      if (el.value && typeof el.value === 'string' && el.type !== 'password') return collapse(el.value);
      return collapse(el.getAttribute('type') || tag);
    }
    const text = collapse(el.innerText || el.textContent);
    if (text) return text;
    const title = collapse(el.getAttribute('title'));
    if (title) return title;
    const alt = collapse(el.getAttribute('alt'));
    if (alt) return alt;
    return '';
  }

  function isUnique(sel: string) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  // Build a selector that resolves to exactly this element.  Nav menus repeat
  // the same shape many times over, so a path that merely *looks* specific can
  // still match a hidden link in another dropdown - which then fails to click.
  function cssPath(el: any): string {
    if (el.id) {
      const byId = '#' + cssEscape(el.id);
      if (isUnique(byId)) return byId;
    }
    const ownTestId = el.getAttribute('data-testid');
    if (ownTestId) {
      const byTestId = el.tagName.toLowerCase() + '[data-testid="' + ownTestId + '"]';
      if (isUnique(byTestId)) return byTestId;
    }

    const parts: string[] = [];
    let node: any = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 14) {
      const tag = node.tagName.toLowerCase();
      let anchor: string | null = null;
      if (node.id) {
        const candidate = '#' + cssEscape(node.id);
        if (isUnique(candidate)) anchor = candidate;
      }
      if (!anchor && node.getAttribute('data-testid')) {
        const candidate = tag + '[data-testid="' + node.getAttribute('data-testid') + '"]';
        if (isUnique(candidate)) anchor = candidate;
      }

      if (anchor) {
        const combined = [anchor, ...parts].join(' > ');
        if (isUnique(combined)) return combined;
        parts.unshift(anchor);
        if (isUnique(parts.join(' > '))) return parts.join(' > ');
      } else {
        let part = tag;
        const parent = node.parentElement;
        if (parent) {
          const sameTag = [...parent.children].filter((c: any) => c.tagName === node.tagName);
          if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        const candidate = parts.join(' > ');
        if (isUnique(candidate)) return candidate;
      }

      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function roleOf(el: any): string {
    const explicit = el.getAttribute('role');
    if (explicit) return collapse(explicit);
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'search') return 'searchbox';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return '';
  }

  const nodes = [...document.querySelectorAll(selector)];
  const out: any[] = [];
  const seen = new Set<string>();
  const vh = window.innerHeight || 0;
  const vw = window.innerWidth || 0;

  for (const el of nodes as any[]) {
    if (out.length >= maxCandidates * 4) break;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (isDisabled(el)) continue;
    if (!isVisible(el)) continue;
    const vis = inViewport(el);
    if (!vis && !includeOffscreen) continue;

    let name = accessibleName(el);
    if (!name) continue;
    if (name.length > maxNameLength) name = name.slice(0, maxNameLength) + '…';

    const tag = el.tagName.toLowerCase();
    const attrs: Record<string, string> = {};
    for (const key of ['type', 'name', 'placeholder', 'href', 'value', 'alt', 'title', 'data-testid']) {
      const v = el.getAttribute(key);
      if (v) attrs[key] = String(v).slice(0, 120);
    }

    let elemSelector = '';
    try { elemSelector = cssPath(el); } catch (e) { elemSelector = ''; }

    const key = tag + '|' + name.toLowerCase() + '|' + (attrs.href || '') + '|' + elemSelector;
    if (seen.has(key)) continue;
    seen.add(key);

    const r = el.getBoundingClientRect();
    out.push({
      tag: tag,
      role: roleOf(el),
      name: name,
      selector: elemSelector,
      attrs: attrs,
      in_viewport: vis,
      bbox: {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      area: Math.round(r.width * r.height),
    });
  }

  return {
    title: document.title || '',
    url: location.href,
    viewport: { w: vw, h: vh },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    headings: [...document.querySelectorAll('h1, h2')].slice(0, 4)
      .map((h) => collapse((h as HTMLElement).innerText || h.textContent)).filter(Boolean),
    total: out.length,
    elements: out,
  };
}

/** One actionable element, as seen by the decision model. */
export interface ElementInfo {
  index: number
  tag: string
  role: string
  name: string
  selector: string
  attrs: Record<string, string>
  inViewport: boolean
  bbox: Record<string, number>
  area: number
}

export function elementLabel(el: ElementInfo): string {
  return `E${el.index + 1}`
}

/** Compact one-line description used as the option criteria. */
export function describeElement(el: ElementInfo): string {
  const bits = [`<${el.tag}>`]
  if (el.role) bits.push(`role=${el.role}`)
  for (const key of ['type', 'placeholder', 'name', 'href', 'title', 'data-testid']) {
    const value = el.attrs[key]
    if (value) bits.push(`${key}="${value.slice(0, 70)}"`)
  }
  if (!el.inViewport) bits.push('(off-screen)')
  return bits.join(' ')
}

/** What the agent is allowed to see: this element and nothing else. */
export function elementToPublic(el: ElementInfo): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tag: el.tag,
    name: el.name,
    selector: el.selector,
    in_viewport: el.inViewport,
  }
  if (el.role) payload.role = el.role
  for (const key of ['type', 'placeholder', 'href', 'title']) {
    if (el.attrs[key]) payload[key] = el.attrs[key]
  }
  if (el.bbox && Object.keys(el.bbox).length > 0) payload.bbox = el.bbox
  return payload
}

/** Internal page snapshot; never returned to the caller verbatim. */
export interface Observation {
  title: string
  url: string
  elements: ElementInfo[]
  headings: string[]
  viewport: Record<string, number>
  scroll: Record<string, number>
  truncatedFrom: number | null
}

/** Tiny, non-revealing stats about the observation (safe to return). */
export function observationSummary(obs: Observation): Record<string, unknown> {
  const info: Record<string, unknown> = {
    candidates: obs.elements.length,
    title: obs.title,
    url: obs.url,
  }
  if (obs.truncatedFrom) info.pruned_from = obs.truncatedFrom
  return info
}

interface RawElement {
  tag?: string
  role?: string
  name?: string
  selector?: string
  attrs?: Record<string, string>
  in_viewport?: boolean
  bbox?: Record<string, number>
  area?: number
}

export interface RawObservation {
  title?: string
  url?: string
  elements?: RawElement[]
  headings?: string[]
  viewport?: Record<string, number>
  scroll?: Record<string, number>
}

/** Convert the raw JS payload into elements, pruning to the budget. */
export function parseObservation(raw: RawObservation, maxCandidates: number): Observation {
  const rawElements = raw.elements ?? []
  const total = rawElements.length

  let selected: RawElement[]
  if (total > maxCandidates) {
    // Keep on-screen elements first (a browser agent can act on them
    // immediately), then larger targets, then document order.
    const ranked = rawElements
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const offA = a.item.in_viewport === false ? 1 : 0
        const offB = b.item.in_viewport === false ? 1 : 0
        if (offA !== offB) return offA - offB
        const areaDiff = (b.item.area ?? 0) - (a.item.area ?? 0)
        if (areaDiff !== 0) return areaDiff
        return a.index - b.index
      })
    const keep = new Set(ranked.slice(0, maxCandidates).map((r) => r.index))
    selected = rawElements.filter((_, i) => keep.has(i))
  } else {
    selected = rawElements
  }

  const elements: ElementInfo[] = selected.map((item, i) => ({
    index: i,
    tag: item.tag ?? '',
    role: item.role ?? '',
    name: item.name ?? '',
    selector: item.selector ?? '',
    attrs: item.attrs ?? {},
    inViewport: item.in_viewport !== false,
    bbox: item.bbox ?? {},
    area: item.area ?? 0,
  }))

  return {
    title: raw.title ?? '',
    url: raw.url ?? '',
    elements,
    headings: raw.headings ?? [],
    viewport: raw.viewport ?? {},
    scroll: raw.scroll ?? {},
    truncatedFrom: total > maxCandidates ? total : null,
  }
}
