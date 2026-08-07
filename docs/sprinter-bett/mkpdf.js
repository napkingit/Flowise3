const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const SRC = '/home/user/Flowise3/docs/sprinter-bett';
const OUT = path.join(process.cwd(), 'pdf');

// Druckbare Hoehe A4 quer: 210 - 13 - 15 = 182 mm = 687,9 px bei 96 dpi
const PAGE_H = 688;

const PRINT_CSS = `
@page { size: A4 landscape; margin: 13mm 10mm 15mm 10mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { max-width: 1040px !important; padding: 0 !important; margin: 0 auto !important; }

/* Tabellen: Kopfzeile auf Folgeseiten wiederholen, nie allein am Seitenfuss */
.tw { overflow: visible !important; }
.tw table { min-width: 0 !important; }
thead { display: table-header-group; }
thead, thead tr { break-inside: avoid; page-break-inside: avoid; break-after: avoid; page-break-after: avoid; }
tr { break-inside: avoid; page-break-inside: avoid; }
tbody tr:first-child { break-before: avoid; page-break-before: avoid; }
tbody tr:last-child { break-before: avoid; page-break-before: avoid; }
tr.sum { break-before: avoid; page-break-before: avoid; }

/* Zeichnungen bleiben immer zusammen */
.zbox { overflow: visible !important; break-inside: avoid; page-break-inside: avoid; }
.zbox svg { min-width: 0 !important; max-width: 100% !important; max-height: 525px; }
figcaption { break-before: avoid; page-break-before: avoid; }

/* Ueberschriften: nie allein am Seitenfuss, Kapitel beginnen auf neuer Seite */
h2 { break-after: avoid; page-break-after: avoid; break-inside: avoid; page-break-inside: avoid; }
h3, h4 { break-after: avoid; page-break-after: avoid; break-inside: avoid; page-break-inside: avoid; }
header.kopf + nav.toc { break-after: auto; }

/* Fliesstext: keine Schusterjungen und Hurenkinder */
p, li, td, th { orphans: 3; widows: 3; }
.hin, .toc, .kopf { break-inside: avoid; page-break-inside: avoid; }

a { color: inherit !important; text-decoration: none; }
`;

const DOCS = [
  { file: 'sprinter-gesamtplan.html',        out: '1_Gesamtplan_Grundriss.pdf',        title: 'SPR-GA-01 · Gesamtplan und Grundriss',            prefix: 'ga' },
  { file: 'sprinter-bett-konstruktion.html', out: '2_Bettkonstruktion.pdf',            title: 'SPR-BETT-01 · Querbett mit 400-mm-Auszug',        prefix: 'be' },
  { file: 'sprinter-elektroplan.html',       out: '3_Elektro_Licht_Bedienung.pdf',     title: 'SPR-EL-01 · Strom, Licht und Bedienung',          prefix: 'el' },
  { file: 'sprinter-bauanleitung.html',      out: '4_Eigenbaumoebel_Bauanleitung.pdf', title: 'SPR-BAU-01 · Eigenbaumöbel, Material, Aufbau',    prefix: 'ba' },
];

function wrap(body) {
  return `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}</style></head><body>
${body}
<style>${PRINT_CSS}</style></body></html>`;
}

// Laeuft im Browser: Kopfzeilen in thead, dann adaptive Umbruchoptimierung
const OPTIMIZE = (PAGE_H) => {
  const SLACK = 10;          // Sicherheitsabstand zur Chrome-Pagination
  const MAX_SHRINK = 260;    // so viel darf eine Zeichnung hoechstens schrumpfen
  const SPLIT_HIN = 300;     // .hin ab dieser Hoehe darf umbrechen statt zu springen

  // 1) Erste Zeile jeder Tabelle in <thead>, damit sie sich auf Folgeseiten wiederholt
  document.querySelectorAll('table').forEach(t => {
    if (t.tHead) return;
    const first = t.rows[0];
    if (!first || !first.querySelector('th')) return;
    const th = document.createElement('thead');
    t.insertBefore(th, t.firstChild);
    th.appendChild(first);
  });

  // 2) Grosse Hinweiskaesten duerfen umbrechen statt eine halbe Seite frei zu lassen
  document.querySelectorAll('.hin').forEach(h => {
    if (h.getBoundingClientRect().height > SPLIT_HIN) {
      h.style.breakInside = 'auto';
      h.style.pageBreakInside = 'auto';
    }
  });

  // 3) Flache Liste aller Umbruch-Einheiten aufbauen
  const buildUnits = () => {
    const units = [];
    for (const el of document.body.children) {
      if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') continue;
      const cs = getComputedStyle(el);
      const forced = el.style.breakBefore === 'page' || cs.breakBefore === 'page';
      if (el.classList.contains('tw')) {
        const t = el.querySelector('table');
        if (t) {
          const rows = [...t.querySelectorAll('tr')];
          rows.forEach((r, i) => units.push({ el: r, kind: 'tr', forced: i === 0 ? forced : false }));
          continue;
        }
      }
      let kind = 'flow';
      if (el.tagName === 'FIGURE') kind = 'figure';
      else if (el.classList.contains('hin') && getComputedStyle(el).breakInside === 'avoid') kind = 'atomic';
      else if (el.classList.contains('toc') || el.classList.contains('kopf')) kind = 'atomic';
      else if (/^H[234]$/.test(el.tagName)) kind = 'head';
      units.push({ el, kind, forced });
    }
    return units;
  };

  // 4) Simulation der Pagination, liefert je Figur die Restluecke
  const simulate = () => {
    const units = buildUnits();
    let y = 0;                       // Fuellstand der aktuellen Seite
    const figures = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const r = u.el.getBoundingClientRect();
      const st = getComputedStyle(u.el);
      const h = r.height + parseFloat(st.marginTop || 0) + parseFloat(st.marginBottom || 0);
      if (u.forced && y > 0) y = 0;
      const free = PAGE_H - y;
      if (u.kind === 'figure') {
        figures.push({ el: u.el, h, free, fits: h <= free });
        y = h <= free ? y + h : h % PAGE_H;
        continue;
      }
      if (u.kind === 'atomic' || u.kind === 'tr' || u.kind === 'head') {
        if (h > free && h < PAGE_H) y = h;      // rutscht auf die naechste Seite
        else y = (y + h) % PAGE_H;
        continue;
      }
      // Fliesstext darf beliebig umbrechen
      y = (y + h) % PAGE_H;
    }
    return figures;
  };

  // 5) Zeichnungen einpassen: entweder auf die laufende Seite verkleinern
  //    oder bewusst als ganzseitige Tafel setzen — dann wandert die zugehoerige
  //    Ueberschrift mit, damit sie nicht allein am Fuss der Vorseite steht.
  const MIN_INLINE = 330;   // so klein darf eine Zeichnung im Fliesstext werden
  const h_ = el => el.getBoundingClientRect().height
                 + parseFloat(getComputedStyle(el).marginTop || 0)
                 + parseFloat(getComputedStyle(el).marginBottom || 0);

  for (let pass = 0; pass < 4; pass++) {
    const figs = simulate();
    let changed = false;
    for (const f of figs) {
      if (f.el.dataset.pb === 'done' || f.fits) continue;
      const svg = f.el.querySelector('svg');
      if (!svg) { f.el.dataset.pb = 'done'; continue; }
      const svgH = svg.getBoundingClientRect().height;
      const overhead = f.h - svgH;
      const need = f.h - f.free + SLACK;          // so viel muss weg, damit sie passt

      if (need <= MAX_SHRINK && svgH - need >= MIN_INLINE) {
        svg.style.maxHeight = Math.floor(svgH - need) + 'px';
      } else {
        // Ganzseitige Tafel. Ueberschriftskette nach oben einsammeln.
        let chain = [], sum = 0, cur = f.el.previousElementSibling;
        while (cur && chain.length < 3) {
          const ph = h_(cur);
          if (sum + ph > 230) { chain = []; sum = 0; break; }
          chain.unshift(cur); sum += ph;
          if (/^H[234]$/.test(cur.tagName)) break;
          cur = cur.previousElementSibling;
        }
        if (!chain.length || !/^H[234]$/.test(chain[0].tagName)) { chain = []; sum = 0; }
        const anchor = chain[0] || f.el;
        anchor.style.breakBefore = 'page';
        anchor.style.pageBreakBefore = 'always';
        if (anchor !== f.el) { f.el.style.breakBefore = 'auto'; f.el.style.pageBreakBefore = 'auto'; }
        const target = PAGE_H - overhead - sum - SLACK;
        if (Math.abs(target - svgH) > 4) svg.style.maxHeight = Math.floor(target) + 'px';
      }
      f.el.dataset.pb = 'done';
      changed = true;
    }
    if (!changed) break;
  }

  // 6) Abschlussbericht
  const figs = simulate();
  return figs.map(f => ({
    k: ((f.el.querySelector('.zk b') || {}).textContent || '?').slice(0, 22),
    h: Math.round(f.h), fits: f.fits,
    svg: Math.round((f.el.querySelector('svg') || { getBoundingClientRect: () => ({ height: 0, width: 0 }) }).getBoundingClientRect().height),
    w: Math.round((f.el.querySelector('svg') || { getBoundingClientRect: () => ({ height: 0, width: 0 }) }).getBoundingClientRect().width),
  }));
};

async function build(page, body, outFile, title) {
  const tmp = path.join(process.cwd(), 'print_tmp.html');
  fs.writeFileSync(tmp, wrap(body));
  await page.goto('file://' + tmp);
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(500);
  const rep = await page.evaluate(`(${OPTIMIZE.toString()})(${PAGE_H})`);
  const bad = rep.filter(r => !r.fits);
  await page.pdf({
    path: outFile,
    format: 'A4', landscape: true, printBackground: true,
    margin: { top: '13mm', bottom: '15mm', left: '10mm', right: '10mm' },
    displayHeaderFooter: true,
    headerTemplate: `<div style="font:7pt -apple-system,sans-serif;color:#666;width:100%;padding:0 12mm;">${title}</div>`,
    footerTemplate: `<div style="font:7pt -apple-system,sans-serif;color:#666;width:100%;padding:0 12mm;text-align:right;">Seite <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
  });
  return bad;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const parts = [];

  for (const d of DOCS) {
    const body = fs.readFileSync(path.join(SRC, d.file), 'utf8');
    const bad = await build(page, body, path.join(OUT, d.out), d.title);
    parts.push(body.replace(/id="(s\d+)"/g, `id="${d.prefix}-$1"`).replace(/href="#(s\d+)"/g, `href="#${d.prefix}-$1"`)
                   .replace(/id="(b\d+)"/g, `id="${d.prefix}-$1"`).replace(/href="#(b\d+)"/g, `href="#${d.prefix}-$1"`));
    console.log('ok', d.out);
  }

  const combined = parts.join('\n<div style="break-before:page;page-break-before:always;height:0"></div>\n');
  const bad = await build(page, combined, path.join(OUT, '0_Sprinter_W907_Ausbau_komplett.pdf'),
    'Mercedes Sprinter W907 L2H2 — Ausbauplanung (Gesamtdokumentation)');
  console.log('ok komplett');
  bad.forEach(x => console.log('   Zeichnung klein:', x.k, x.svg + 'x' + x.w));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
