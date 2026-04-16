/* Still — main-world patch
 *
 * Runs in the page's main JS world (not the content-script isolated world)
 * so that prototype patches here affect the SAME Element.prototype that
 * page scripts see when they call setAttribute.
 *
 * Loaded via manifest.json content_scripts entry with "world": "MAIN" at
 * document_start — fires BEFORE any page script has a chance to start
 * mutating SVG.
 *
 * Scope: defuse D3-style chart reveal animations that mutate an SVG
 * element's geometry attributes (`d` on path, cx/cy/r on circle, etc.)
 * every rAF tick. Neither CSS animation overrides, WAAPI cancellation,
 * nor stroke-dashoffset rules catch this because the geometry itself is
 * changing. The patch adds `data-still-svg-settling` synchronously on
 * every relevant write, and a 300ms debounced timer removes it once
 * mutations stop — meaning the chart has reached its final state. A CSS
 * rule in content.js (isolated world, via <style> injection) hides
 * elements with that attribute.
 */
(function () {
  const SETTLE_MS = 300;
  const svgSettleTimers = new WeakMap();
  const origSetAttribute = Element.prototype.setAttribute;
  const origSetAttributeNS = Element.prototype.setAttributeNS;

  // SVG geometry attributes that chart libraries animate. We keep this list
  // narrow on purpose — including `x`, `y`, `width`, `height` would catch bar-
  // chart reveal animations but also trigger 300ms hides on static SVG icons
  // that frameworks (React hydration, etc.) re-apply those attrs to during
  // mount. That flash-of-hidden-content across potentially every icon on a
  // page isn't worth the coverage. Chart libraries targeting those attrs
  // specifically will slip through; revisit if reported.
  const GEOM_ATTRS = new Set([
    'd', 'points', 'transform',
    'cx', 'cy', 'r', 'rx', 'ry',
    'x1', 'y1', 'x2', 'y2',
  ]);

  function markSettling(el) {
    origSetAttribute.call(el, 'data-still-svg-settling', '');
    const existing = svgSettleTimers.get(el);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      el.removeAttribute('data-still-svg-settling');
      svgSettleTimers.delete(el);
    }, SETTLE_MS);
    svgSettleTimers.set(el, t);
  }

  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof SVGElement && GEOM_ATTRS.has(name)) {
      markSettling(this);
    }
    return origSetAttribute.apply(this, arguments);
  };

  Element.prototype.setAttributeNS = function (ns, name, value) {
    if (this instanceof SVGElement && GEOM_ATTRS.has(name)) {
      markSettling(this);
    }
    return origSetAttributeNS.apply(this, arguments);
  };
})();
