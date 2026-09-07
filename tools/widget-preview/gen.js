'use strict';

const fs = require('fs');
const path = require('path');

const THEMES = {
  light: {
    card: '#FFFFFF',
    shape: '#D6DAE2',
    car: '#C3C8D2',
    track: '#E4E7EC',
    shadow: 'rgba(17,24,39,0.13)',
    icon: '#8E939E',
  },
  dark: {
    card: '#3A3A3C',
    shape: '#57575A',
    car: '#6B6B70',
    track: '#4E4E51',
    shadow: 'rgba(0,0,0,0.55)',
    icon: '#A8ACB3',
  },
};

const GREEN = '#34C759';
const BLUE = '#0A84FF';

// Simplified side profile: one body outline + two wheels, no detail lines.
const CAR = 'M 24,168 C 24,140 40,132 62,126 L 118,110 L 168,58 C 176,46 190,40 206,40 '
  + 'L 300,40 C 320,40 336,48 348,62 L 386,110 L 420,120 C 440,126 452,140 452,160 '
  + 'L 452,176 C 452,186 444,192 434,192 L 42,192 C 32,192 24,186 24,176 Z';

// Each icon is drawn inside a 48x48 box, centred in its tile.
const ICONS = {
  lock: '<rect x="9" y="21" width="30" height="22" rx="6"/>'
    + '<path d="M16 21 V15 a8 8 0 0 1 16 0 v6" fill="none" stroke-width="5" stroke-linecap="round"/>',
  bolt: '<path d="M27 4 L11 27 h9 l-3 17 16-23 h-9 z"/>',
  fan: '<circle cx="24" cy="24" r="5"/>'
    + '<path d="M24 19 C24 8 20 3 26 3 c6 0 6 9 -2 16 z"/>'
    + '<path d="M28 26 C38 29 44 27 41 33 c-3 5 -10 1 -13 -9 z"/>'
    + '<path d="M20 26 C10 29 4 27 7 33 c3 5 10 1 13 -9 z"/>',
  defrost: '<path d="M6 30 a18 18 0 0 1 36 0 z"/>'
    + '<path d="M15 36 q3 4 0 8 M24 36 q3 4 0 8 M33 36 q3 4 0 8" fill="none" stroke-width="4" stroke-linecap="round"/>',
};

const ICON_SCALE = 1.75;
const icon = (name, cx, cy, color) => `<g transform="translate(${cx},${cy}) scale(${ICON_SCALE}) translate(-24,-24)" fill="${color}" stroke="${color}">${ICONS[name]}</g>`;

const svg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="${t.shadow}"/>
    </filter>
  </defs>

  <!-- header: name / sub-line placeholders + status pill -->
  <rect x="72" y="92" width="224" height="34" rx="17" fill="${t.shape}"/>
  <rect x="72" y="142" width="148" height="24" rx="12" fill="${t.shape}"/>
  <rect x="692" y="98" width="260" height="60" rx="30" fill="${t.card}" filter="url(#shadow)"/>
  <circle cx="736" cy="128" r="11" fill="${BLUE}"/>
  <rect x="762" y="118" width="150" height="20" rx="10" fill="${t.shape}"/>

  <!-- car -->
  <g transform="translate(274,214)">
    <path d="${CAR}" fill="${t.car}"/>
    <circle cx="120" cy="192" r="40" fill="${t.car}"/>
    <circle cx="356" cy="192" r="40" fill="${t.car}"/>
    <circle cx="120" cy="192" r="17" fill="${t.card}"/>
    <circle cx="356" cy="192" r="17" fill="${t.card}"/>
  </g>

  <!-- battery card -->
  <rect x="72" y="512" width="880" height="146" rx="30" fill="${t.card}" filter="url(#shadow)"/>
  <rect x="116" y="552" width="96" height="30" rx="15" fill="${t.shape}"/>
  <rect x="812" y="552" width="96" height="30" rx="15" fill="${t.shape}"/>
  <rect x="116" y="606" width="792" height="26" rx="13" fill="${t.track}"/>
  <rect x="116" y="606" width="673" height="26" rx="13" fill="${GREEN}"/>

  <!-- four action tiles -->
  ${[['lock', 72], ['bolt', 297], ['fan', 522], ['defrost', 747]].map(([name, x]) => `
  <rect x="${x}" y="712" width="205" height="205" rx="34" fill="${t.card}" filter="url(#shadow)"/>
  ${icon(name, x + 102.5, 814.5, t.icon)}`).join('')}
</svg>`;

const outDir = __dirname;
for (const [name, t] of Object.entries(THEMES)) {
  fs.writeFileSync(path.join(outDir, `preview-${name}.svg`), svg(t));
  fs.writeFileSync(path.join(outDir, `preview-${name}.html`),
    `<style>html,body{margin:0;background:transparent}</style>${svg(t)}`);
}
console.log('wrote svg + html');
