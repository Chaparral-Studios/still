#!/bin/bash
# Generate placeholder icons for the Still extension
# Requires ImageMagick (brew install imagemagick)
# Creates a simple "S" icon with a pause symbol aesthetic

for size in 16 32 48 128; do
  convert -size ${size}x${size} xc:'#4A90D9' \
    -gravity center -fill white -font Helvetica-Bold \
    -pointsize $((size * 6 / 10)) \
    -annotate +0+0 'S' \
    "icon-${size}.png"
done

echo "Icons generated."
