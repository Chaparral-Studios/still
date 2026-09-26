# Still v1.9 — App Store "What's New"

Fixes a flicker on news sites when scrolling on a phone. A scrolling
finger that happened to start on a video was being treated as a tap on
it, so the video could start playing under your finger — and, with a
second autoplay blocker installed, strobe its poster and play button as
the two fought over it. Scrolling now never counts as a tap; tapping a
play button still works.
