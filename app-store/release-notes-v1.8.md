# Still v1.8 — App Store "What's New"

Still now stops the animations that scripts draw frame by frame. Text and
images that zoom, slide or fade into place as a page loads — and the
scroll-driven effects on modern marketing sites — simply appear in their
final position instead of moving there.

Animations hidden inside web components are covered too, along with
animations a page starts long after it has loaded, like a menu or dialog
that slides closed.

Videos stay paused more reliably. Players that kept trying to restart
themselves could flicker rapidly; Still now refuses the playback up front,
so the video sits still until you press play.
