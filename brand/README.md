# Branding

Two apps ship from this repo — `com.kia` and `com.hyundai` — and they differ only
in wording, colour and artwork. `main` is the single place anyone edits, and it
holds the **Kia** build. The branded branches are **generated, never merged**.

## Why not merge

The brand difference is interleaved with real content inside shared files, and a
merge cannot tell the two apart. Worse, it is not a find-and-replace:

| Kia | Hyundai |
| --- | --- |
| `Kia Connect` | `Hyundai Bluelink` |
| `set its time in the Kia app` | `set its time in the Bluelink app` |
| `Kia/Hyundai server not reachable` | `Hyundai server not reachable` |

Substituting "Kia" → "Hyundai" gets all three wrong. Kia wording reached the
published Hyundai app twice this way. Generation removes the failure mode
entirely: the Hyundai text is not edited, it is produced.

## Layout

Only what genuinely differs between the two apps lives here.

```
brand/
  src/                 shared sentences with {{TOKEN}} blanks — the ONLY files
    locales/*.json       you must edit here instead of at the root
    drivers/car/driver.settings.compose.json
  kia/
    brand.json           token values + the 5 app.json keys that differ
    README*.txt          store copy (different text, not a token swap)
    assets/…             app + driver artwork
  hyundai/             same shape
  logos/               design sources, shipped by neither app
```

Tokens: `{{BRAND}}` `{{BRAND_UC}}` `{{SERVICE}}` `{{APPNAME}}` `{{SERVERS}}` `{{APP_ID}}`.

## Daily work

Work on `main` exactly as before — it *is* the Kia app, so `homey app run`
just works. One rule:

> **Changing user-facing text? Edit `brand/src/locales/…`.
> Everything else: edit normally at the root.**

`.homeycompose/app.json` and `package.json` are *not* owned by this tool — it
patches only the handful of brand keys inside them (`id`, `name`, `brandColor`,
`description`, `tags`, and the package `name`). Version bumps, compatibility,
permissions, scripts, dependencies and `.homeychangelog.json` are edited at the
root as they always were.

`npm run brand:check` fails if you edit a rendered file directly, and also if a
compose manifest picks up the other brand's wording.

## Shipping

```sh
npm run brand:check                 # on main: tree matches the Kia render

# Kia
git checkout com.kia && git reset --hard main
homey app build && homey app publish

# Hyundai
git checkout com.hyundai && git reset --hard main
npm run brand -- hyundai
homey app build                     # regenerates app.json from .homeycompose
git commit -am "Render com.hyundai from main"
homey app publish
```

Both branches are disposable: anything on them that `main` plus `brand/` cannot
reproduce is a bug. Per existing convention the version bump and changelog entry
are made on `main` only.
