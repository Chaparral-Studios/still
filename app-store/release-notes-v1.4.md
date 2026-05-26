• Stops the spinning 3D product previews on Google Shopping search results. These silently auto-rotating product cards bypass Safari's autoplay control because they ship as muted, inline videos rather than animated images — Still now blocks them at the network and DOM layers.

• Even on long, fast-scrolling result pages, product spinners are caught the moment they appear. A previous timing window briefly let cards play before being blocked; the new defense gates on the video URL itself, so there's no race.

• Polish: blocked video previews are now fully removed from page layout, eliminating a case where the browser kept rendering frames on a "hidden" video element and leaving subtle motion visible.
