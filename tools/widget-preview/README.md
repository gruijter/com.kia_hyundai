# Widget preview source

`widgets/car/preview-light.png` and `preview-dark.png` are generated, not drawn by hand
and never a screenshot of the widget — App Store guideline 1.10 rejects both screenshots
and any text in a widget preview, which is what the first submission was rejected for.

Dev-only: tracked by git so the previews stay reproducible, but `/tools/` is in
`.homeyignore`, so nothing here reaches the published app or is loaded at runtime.

Regenerate after changing the widget layout:

    cd tools/widget-preview
    node gen.js                                   # writes preview-{light,dark}.{svg,html}
    for m in light dark; do
      google-chrome --headless --disable-gpu --hide-scrollbars \
        --default-background-color=00000000 --window-size=1024,1024 \
        --screenshot=preview-$m.png preview-$m.html
    done
    cp preview-*.png ../../widgets/car/

`--default-background-color=00000000` is what keeps the background transparent; the
guideline requires that, plus 1024x1024, no text, and simple shapes over detailed art.
Athom also publish a Figma template for this if a hand-made version is ever preferred.
