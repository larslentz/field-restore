import { toBlob } from 'html-to-image';
import { zipSync } from 'fflate';

const WIDTH = 1080;
const HEIGHT = 1350;
const COUNT = 10;

function bounded<T>(work: Promise<T>, label: string, milliseconds = 60000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out. Please try again.`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fetchFresh(url: string): Promise<Response> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not load an export asset (${response.status}): ${url}`);
  return response;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read an export asset.'));
    reader.readAsDataURL(blob);
  });
}

/** Embed only used web fonts. Unlike permissive DOM capture defaults, any
 * failed stylesheet/font fetch aborts the batch rather than substituting fonts. */
async function embedFonts(doc: Document, wrappers: HTMLElement[]): Promise<string> {
  const win = doc.defaultView!;
  const families = new Set<string>();
  const requests = new Map<string, string>();
  for (const wrapper of wrappers) {
    for (const element of wrapper.querySelectorAll<HTMLElement>('*')) {
      if (![...element.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim())) continue;
      const style = win.getComputedStyle(element);
      const family = style.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      families.add(family.toLowerCase());
      requests.set(`${style.fontStyle} ${style.fontWeight} 16px "${family}"`, element.textContent || 'Field Restore');
    }
  }
  // Explicit load detects missing faces; fonts.ready alone also resolves when a font fails.
  for (const [font, text] of requests) {
    const loaded = await bounded(doc.fonts.load(font, text), 'Font loading');
    if (!loaded.length) throw new Error(`The export font is unavailable: ${font}`);
  }
  await bounded(doc.fonts.ready, 'Font loading');

  const embedded: string[] = [];
  const urls = new Map<string, Promise<string>>();
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    // Vite's app styles have no font faces; Google styles may be cross-origin
    // and therefore cannot be read through CSSStyleSheet.cssRules.
    const css = await (await fetchFresh(link.href)).text();
    for (const face of css.match(/@font-face\s*\{[^}]*\}/g) || []) {
      const family = face.match(/font-family:\s*([^;]+);/)?.[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (!family || !families.has(family)) continue;
      let inlined = face;
      for (const match of face.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const url = new URL(match[1], link.href).href;
        if (!urls.has(url)) urls.set(url, fetchFresh(url).then(r => r.blob()).then(dataUrl));
        inlined = inlined.replace(match[0], `url("${await urls.get(url)}")`);
      }
      embedded.push(inlined);
    }
  }
  if (!embedded.length) throw new Error('No export fonts could be embedded. Check your connection and try again.');
  return embedded.join('\n');
}

/** Freeze decoded images/backgrounds as data URLs before capture, so the
 * capture library cannot silently replace a failed fetch with a blank image. */
async function embedAssets(doc: Document, wrappers: HTMLElement[]): Promise<void> {
  const win = doc.defaultView!;
  const assets = new Map<string, Promise<string>>();
  const load = (url: string) => {
    if (!assets.has(url)) assets.set(url, fetchFresh(url).then(r => r.blob()).then(dataUrl));
    return assets.get(url)!;
  };
  for (const wrapper of wrappers) {
    for (const image of wrapper.querySelectorAll<HTMLImageElement>('img')) {
      const url = image.currentSrc || image.src;
      image.removeAttribute('srcset');
      image.src = await load(url);
      await bounded(image.decode(), 'Image decoding');
      if (!image.naturalWidth) throw new Error(`An export image is empty: ${url}`);
    }
    for (const element of [wrapper, ...wrapper.querySelectorAll<HTMLElement>('*')]) {
      let background = win.getComputedStyle(element).backgroundImage;
      for (const match of [...background.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]) {
        const url = new URL(match[1], doc.baseURI).href;
        const embedded = await load(url);
        const image = new Image();
        image.src = embedded;
        await bounded(image.decode(), 'Background image decoding');
        background = background.replace(match[0], `url("${embedded}")`);
      }
      if (background !== 'none') element.style.backgroundImage = background;
    }
  }
}

export async function exportCarousel(onProgress: (message: string) => void): Promise<Blob> {
  const frame = document.createElement('iframe');
  frame.title = 'Carousel export renderer';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${WIDTH}px;height:${HEIGHT}px;border:0;pointer-events:none;`;
  const base = import.meta.env.BASE_URL;
  try {
    onProgress('Loading the current saved deck…');
    const loaded = new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error('Could not load the deck for export.'));
    });
    // A new document on every click: no previously generated image or mounted
    // export deck is reused. Motion is deliberately not enabled.
    frame.src = `${base}allslides?replitNav=parent&carouselExport=${crypto.randomUUID()}`;
    document.body.appendChild(frame);
    await bounded(loaded, 'Deck loading');
    const doc = frame.contentDocument;
    if (!doc) throw new Error('The export renderer could not be accessed.');
    // The load event may precede React committing its initial render.
    await bounded(new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const poll = () => {
        if (doc.querySelectorAll('.slide[data-slide-id]').length === COUNT) resolve();
        else if (performance.now() - started > 15000) reject(new Error('Expected ten rendered slides. Check the deck for errors.'));
        else setTimeout(poll, 50);
      };
      poll();
    }), 'Slide rendering', 20000);
    const wrappers = [...doc.querySelectorAll<HTMLElement>('.slide[data-slide-id]')];
    for (const [index, wrapper] of wrappers.entries()) {
      const rect = wrapper.getBoundingClientRect();
      const root = wrapper.querySelector<HTMLElement>('[data-sdm-ready="true"]');
      const stage = root?.firstElementChild as HTMLElement | null;
      if (rect.width !== WIDTH || rect.height !== HEIGHT ||
          stage?.style.width !== `${WIDTH}px` || stage?.style.height !== `${HEIGHT}px` ||
          wrapper.textContent?.includes('Invalid SDM slide')) {
        throw new Error(`Slide ${index + 1} is invalid or is not a 1080 × 1350 portrait slide.`);
      }
    }
    onProgress('Loading fonts and images…');
    const fontEmbedCSS = await embedFonts(doc, wrappers);
    await embedAssets(doc, wrappers);
    // Let font metrics/autofit and image layout settle before rasterization.
    await bounded(new Promise<void>(resolve => frame.contentWindow!.requestAnimationFrame(() =>
      frame.contentWindow!.requestAnimationFrame(() => resolve()))), 'Layout settling');
    const files: Record<string, Uint8Array> = {};
    for (const [index, wrapper] of wrappers.entries()) {
      onProgress(`Exporting image ${index + 1} of ${COUNT}…`);
      const png = await bounded(toBlob(wrapper, {
        width: WIDTH, height: HEIGHT, canvasWidth: WIDTH, canvasHeight: HEIGHT,
        pixelRatio: 1, fontEmbedCSS, skipAutoScale: true,
      }), `Slide ${index + 1} capture`);
      if (!png || png.type !== 'image/png' || !png.size) throw new Error(`Slide ${index + 1} could not be captured.`);
      files[`Field-Restore-${String(index + 1).padStart(2, '0')}.png`] = new Uint8Array(await png.arrayBuffer());
    }
    onProgress('Preparing ZIP…');
    // PNGs are already compressed; storing them avoids unnecessary CPU work.
    const zip = zipSync(files, { level: 0 });
    return new Blob([new Uint8Array(zip)], { type: 'application/zip' });
  } finally {
    frame.remove();
  }
}
