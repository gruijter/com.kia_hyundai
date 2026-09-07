'use strict';

/**
 * Renders the repo as one specific brand.
 *
 * `main` is the only branch anyone edits, and it holds the Kia build. Every
 * file that differs between the two published apps is either a token-rendered
 * template under brand/src/, or per-brand content under brand/<brand>/. This
 * script combines the two and writes the result into the tree, so com.kia and
 * com.hyundai are regenerated rather than merged — a merge cannot tell a brand
 * string from a real change, which is how Kia text twice reached the Hyundai
 * app (and why the substitution is token-based: "Kia/Hyundai server" becomes
 * "Hyundai server", and "the Kia app" becomes "the Bluelink app", neither of
 * which a find-and-replace on "Kia" would get right).
 *
 *   node tools/brand/apply.js hyundai          write the Hyundai build
 *   node tools/brand/apply.js kia --check      fail if the tree has drifted
 *
 * --check is the guard against editing a rendered file (locales/en.json, say)
 * without editing its template: rendering `kia` must reproduce main exactly.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'brand', 'src');

// Templates render to the same path they occupy under brand/src/. Only files
// where a brand word sits *inside* a shared sentence belong here.
const TEMPLATES = [
  ...fs.readdirSync(path.join(SRC, 'locales')).map((f) => `locales/${f}`),
  'drivers/car/driver.settings.compose.json',
];

// Files that are mostly shared but carry a few brand-specific keys. Only those
// keys are patched, so everything around them — version, compatibility,
// permissions, scripts, dependencies — is edited normally at the root and is
// none of this tool's business. (These files used to be templated whole, which
// meant bumping a version had to be done inside brand/src/: friction for a
// value that is identical in both apps.)
const PATCHED = {
  '.homeycompose/app.json': (json, cfg) => Object.assign(json, cfg.appJson),
  'package.json': (json, cfg) => Object.assign(json, { name: cfg.tokens.APP_ID }),
};

// Copied verbatim from brand/<brand>/: genuinely different content per brand
// rather than a token swap — store copy and artwork. NOT the changelog: 18 of
// its 19 entries were already identical, so it is shared and edited at root.
const VERBATIM = [
  'assets/icon.svg',
  'assets/images/small.png',
  'assets/images/large.png',
  'assets/images/xlarge.png',
  'drivers/car/assets/icon.svg',
  'drivers/car/assets/images/small.png',
  'drivers/car/assets/images/large.png',
  'drivers/car/assets/images/xlarge.png',
];

const render = (text, tokens) => text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
  if (!(name in tokens)) throw Error(`Unknown token {{${name}}} in template`);
  return tokens[name];
});

function build(brand) {
  const brandDir = path.join(ROOT, 'brand', brand);
  if (!fs.existsSync(brandDir)) throw Error(`No such brand: ${brand}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(brandDir, 'brand.json'), 'utf8'));

  const out = new Map(); // repo-relative path -> Buffer

  for (const rel of TEMPLATES) {
    const text = render(fs.readFileSync(path.join(SRC, rel), 'utf8'), cfg.tokens);
    out.set(rel, Buffer.from(`${JSON.stringify(JSON.parse(text), null, 2)}\n`));
  }

  // Patch in place: read what is on disk, overwrite only the brand keys, keep
  // every other key and its position exactly as the author left it.
  for (const [rel, patch] of Object.entries(PATCHED)) {
    const target = path.join(ROOT, rel);
    if (!fs.existsSync(target)) continue;
    const json = JSON.parse(fs.readFileSync(target, 'utf8'));
    patch(json, cfg);
    out.set(rel, Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
  }

  for (const rel of fs.readdirSync(brandDir).filter((f) => f.startsWith('README'))) {
    out.set(rel, fs.readFileSync(path.join(brandDir, rel)));
  }
  for (const rel of VERBATIM) {
    out.set(rel, fs.readFileSync(path.join(brandDir, rel)));
  }

  // package-lock.json carries the package name too, but it is npm's file — a
  // targeted field edit beats templating a lockfile that churns on install.
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.name = cfg.tokens.APP_ID;
    if (lock.packages && lock.packages['']) lock.packages[''].name = cfg.tokens.APP_ID;
    out.set('package-lock.json', Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
  }

  return out;
}

// Rendering makes a brand leak impossible in the managed files above, but not
// in the ones nobody templated — a new flow-card title or capability hint can
// still say "Kia" and would ship verbatim into the Hyundai app.
//
// Scoped deliberately to the compose manifests, i.e. the text Homey renders in
// the UI. Not .js and not hostnames: the client legitimately talks about both
// brands (BRAND_MAP, prd.eu-ccapi.hyundai.com, "Kia/Hyundai USA" comments) and
// scanning those produces dozens of false positives that train you to ignore
// the check — which is worse than not having one.
// Under .homeycompose/ every .json is a compose source (flow cards are named
// after the card, e.g. flow/actions/windows_vent.json — an earlier version of
// this only matched *.compose.json and silently scanned none of them).
// Elsewhere only the *.compose.json manifests carry user-visible text.
const SCAN_ROOTS = [
  { dir: '.homeycompose', match: (f) => f.endsWith('.json') },
  { dir: 'drivers', match: (f) => f.endsWith('.compose.json') },
  { dir: 'widgets', match: (f) => f.endsWith('.compose.json') },
];
// The repository really is called com.kia_hyundai and both apps link to it.
const ALLOWED = [/github\.com\/gruijter\/com\.kia_hyundai/];

function scanForForeignBrand(brand, managed) {
  const foreign = brand === 'kia'
    ? [/\bhyundai\b/i, /\bbluelink\b/i, /\bioniq\b/i]
    : [/\bkia\b/i, /\buvo\b/i, /\bniro\b/i];
  const hits = [];
  const walk = (dir, match) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, match);
        continue;
      }
      if (!match(entry.name)) continue;
      const rel = path.relative(ROOT, full);
      if (managed.has(rel)) continue; // rendered, therefore correct by construction
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (ALLOWED.some((ok) => ok.test(line))) return;
        if (foreign.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  };
  SCAN_ROOTS.forEach((r) => walk(path.join(ROOT, r.dir), r.match));
  return hits;
}

function main() {
  const [brand, ...flags] = process.argv.slice(2);
  if (!brand) {
    console.error('usage: node tools/brand/apply.js <kia|hyundai> [--check]');
    process.exit(2);
  }
  const check = flags.includes('--check');
  const out = build(brand);

  const drifted = [];
  let written = 0;
  for (const [rel, buffer] of out) {
    const target = path.join(ROOT, rel);
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (current && current.equals(buffer)) continue;
    if (check) {
      drifted.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    written += 1;
  }

  if (check) {
    if (drifted.length) {
      console.error(`${drifted.length} file(s) differ from what brand/ renders for "${brand}":`);
      drifted.forEach((f) => console.error(`  ${f}`));
      console.error('\nEdit brand/src/ or brand/<brand>/ rather than the rendered file, then re-run.');
      process.exit(1);
    }
    const hits = scanForForeignBrand(brand, new Set(out.keys()));
    if (hits.length) {
      console.error(`Other-brand wording in files brand/ does not manage (build is "${brand}"):`);
      hits.forEach((h) => console.error(`  ${h}`));
      console.error('\nMove the string into a brand/src/ template so it renders per brand.');
      process.exit(1);
    }
    console.log(`brand check OK - tree matches "${brand}", no foreign brand wording`);
    return;
  }
  console.log(`Rendered as "${brand}" (${written} file(s) changed). Now run: homey app build`);
}

main();
