'use strict';
/*
 * The Reseed icon set, on a 24-unit grid, 1.7 stroke, round caps.
 *
 * These are the same shapes as the inline <symbol> sprite in
 * desktop/ui/index.html — kept here in data form so the Android vector
 * drawables can be generated rather than redrawn by hand.
 *
 * Each entry is a list of shapes:
 *   { d, stroke? , fill?, cap?, join? }   stroke defaults true, fill defaults false
 */

// Vector drawables have no <circle>, so every circle becomes two arcs.
const circle = (cx, cy, r) =>
  `M${cx},${cy - r} a${r},${r} 0 1,0 0,${2 * r} a${r},${r} 0 1,0 0,${-2 * r} Z`;

const S = (d, extra) => Object.assign({ d, stroke: true, fill: false }, extra);
const F = (d, extra) => Object.assign({ d, stroke: false, fill: true }, extra);

module.exports = {
  ic_run: [F('M8.6,5.8 L18.4,12 L8.6,18.2 Z')],

  ic_stop: [F('M9.3,7.5 h5.4 a1.8,1.8 0 0 1 1.8,1.8 v5.4 a1.8,1.8 0 0 1 -1.8,1.8 h-5.4 a1.8,1.8 0 0 1 -1.8,-1.8 v-5.4 a1.8,1.8 0 0 1 1.8,-1.8 Z')],

  ic_tag: [
    S('M4,11.4 V5.6 A1.6,1.6 0 0 1 5.6,4 h5.8 a1.6,1.6 0 0 1 1.13,0.47 l6.9,6.9 a1.6,1.6 0 0 1 0,2.26 l-5.8,5.8 a1.6,1.6 0 0 1 -2.26,0 l-6.9,-6.9 A1.6,1.6 0 0 1 4,11.4 Z', { join: 'round' }),
    S(circle(8.2, 8.2, 1.35))
  ],

  ic_youtube: [
    S('M6.7,5 h10.6 a4.2,4.2 0 0 1 4.2,4.2 v5.6 a4.2,4.2 0 0 1 -4.2,4.2 h-10.6 a4.2,4.2 0 0 1 -4.2,-4.2 v-5.6 a4.2,4.2 0 0 1 4.2,-4.2 Z', { join: 'round' }),
    F('M10.4,9.3 L15,12 L10.4,14.7 Z')
  ],

  ic_instagram: [
    S('M8.5,3.5 h7 a5,5 0 0 1 5,5 v7 a5,5 0 0 1 -5,5 h-7 a5,5 0 0 1 -5,-5 v-7 a5,5 0 0 1 5,-5 Z', { join: 'round' }),
    S(circle(12, 12, 4)),
    F(circle(16.9, 7.1, 1.15))
  ],

  ic_clock: [
    S(circle(12, 12, 8.3)),
    S('M12,7.4 V12 l3.1,1.9', { cap: 'round' })
  ],

  ic_layers: [
    S('M12,3.4 L20.4,7.6 L12,11.8 L3.6,7.6 Z', { join: 'round' }),
    S('M3.6,12.2 L12,16.4 L20.4,12.2', { cap: 'round', join: 'round' }),
    S('M3.6,16.6 L12,20.8 L20.4,16.6', { cap: 'round', join: 'round' })
  ],

  ic_search: [
    S(circle(10.8, 10.8, 6.3)),
    S('M15.4,15.4 L20,20', { cap: 'round' })
  ],

  ic_eye: [
    S('M2.6,12 C4.4,9 7.8,6.2 12,6.2 C16.2,6.2 19.6,9 21.4,12 C19.6,15 16.2,17.8 12,17.8 C7.8,17.8 4.4,15 2.6,12 Z', { join: 'round' }),
    S(circle(12, 12, 2.7))
  ],

  ic_heart: [
    S('M12,19.6 L4.9,12.8 a4.4,4.4 0 0 1 6.2,-6.2 l0.9,0.9 l0.9,-0.9 a4.4,4.4 0 1 1 6.2,6.2 Z', { join: 'round' })
  ],

  ic_bell: [
    S('M6.4,16.6 V11 a5.6,5.6 0 0 1 11.2,0 v5.6 l1.5,2.1 H4.9 Z', { join: 'round' }),
    S('M10.2,21.2 h3.6', { cap: 'round' })
  ],

  ic_block: [
    S(circle(12, 12, 8.3)),
    S('M6.5,17.5 L17.5,6.5', { cap: 'round' })
  ],

  // History, struck through — "the old history".
  ic_history: [
    S(circle(12, 12, 8.3)),
    S('M12,7.4 V12 l3.1,1.9', { cap: 'round' }),
    S('M5.9,18.1 L18.1,5.9', { cap: 'round' })
  ],

  ic_shield: [
    S('M12,3.4 L19.2,6 v6 c0,4.2 -3,7.2 -7.2,8.6 C7.8,19.2 4.8,16.2 4.8,12 V6 Z', { join: 'round' }),
    S('M9.2,12.1 L11.3,14.2 L15,10.4', { cap: 'round', join: 'round' })
  ],

  ic_alert: [
    S('M12,4.2 L21,19.4 H3 Z', { join: 'round' }),
    S('M12,10 v4.1', { cap: 'round' }),
    F(circle(12, 16.8, 0.95))
  ],

  ic_chevron: [S('M6.5,9.5 L12,15 L17.5,9.5', { cap: 'round', join: 'round' })],

  ic_close: [S('M6.6,6.6 L17.4,17.4 M17.4,6.6 L6.6,17.4', { cap: 'round' })],

  ic_home: [
    S('M4,10.4 L12,4 L20,10.4 V19 a1.2,1.2 0 0 1 -1.2,1.2 H5.2 A1.2,1.2 0 0 1 4,19 Z', { join: 'round' }),
    S('M9.6,20.2 v-6 h4.8 v6', { join: 'round' })
  ],

  ic_reload: [
    S('M19.4,12 a7.4,7.4 0 1 1 -2.2,-5.3', { cap: 'round' }),
    S('M19.7,4.4 v4.2 h-4.2', { cap: 'round', join: 'round' })
  ]
};
