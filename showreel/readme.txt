showreel.mp4   the showreel — H.264 MP4, 1080x1920 vertical, faststart, 20MB
poster.jpg     the still shown before it plays (frame from 28s)

Both bokko.co and bokko.co/portfolio point at these exact filenames, so one
copy serves both pages. To swap in a new cut later, keep the same two
filenames and replace the files — no code change needed. Netlify caches
hard, so allow a few minutes.

If the section ever disappears, it means the browser couldn't load
showreel.mp4 — the page hides it rather than showing a broken player.

To prepare a replacement:

  ffmpeg -i NEW-SHOWREEL.mov -c:v libx264 -preset fast -crf 26 \
    -maxrate 3500k -bufsize 7000k -pix_fmt yuv420p -profile:v high \
    -c:a aac -b:a 128k -movflags +faststart showreel.mp4

  ffmpeg -ss 28 -i showreel.mp4 -frames:v 1 -vf scale=900:-2 -q:v 3 poster.jpg

(Add -vf "scale=-2:1080" if the new cut is horizontal — the page detects
portrait vs landscape automatically and lays out to match.)
