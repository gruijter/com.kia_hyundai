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

```
brand/
  src/                 templates shared by both brands, with {{TOKEN}} placeholders
    locales/*.json
    .homeycompose/app.json
    drivers/car/driver.settings.compose.json
    package.json
  kia/                 what is Kia-specific
    brand.json           token values + brandColor + description + tags
    README*.txt          store copy (genuinely different text, not a token swap)
    .homeychangelog.json per-app release history
    assets/…             app + driver artwork
  hyundai/             same shape
  logos/               design sources, shipped by neither app
```

Tokens: `{{BRAND}}` `{{BRAND_UC}}` `{{SERVICE}}` `{{APPNAME}}` `{{SERVERS}}` `{{APP_ID}}`.

## Daily work

Work on `main` exactly as before — it *is* the Kia app, so `homey app run`
just works. The one rule:

> Edit `brand/src/…`, never the rendered file.

Rendered files are `locales/*.json`, `package.json`, `.homeycompose/app.json`,
`drivers/car/driver.settings.compose.json`, the `README*.txt` and the artwork.
`npm run brand:check` fails if you edit one directly, and also fails if a
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
