const paths = {
  project:'M3 6h6l2 2h10v12H3z M3 6V4h7l2 2', search:'M15.5 15.5 21 21 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  problems:'M12 3 2 21h20z M12 9v5 M12 17v1', packages:'M12 2 2 7v10l10 5 10-5V7z M2 7l10 5 10-5 M12 12v10',
  run:'m7 4 14 8-14 8z', stop:'M5 5h14v14H5z', terminal:'m3 5 6 7-6 7 M11 19h10',
  settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  dsh:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z', command:'M8 8H5a3 3 0 1 1 3-3v14a3 3 0 1 1-3-3h14a3 3 0 1 1-3 3V5a3 3 0 1 1 3 3H8',
  theme:'M12 3a9 9 0 1 0 9 9 9 9 0 0 1-9-9', save:'M4 3h13l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
  more:'M4 12h2 M11 12h2 M18 12h2', history:'M3 11a9 9 0 1 1 2 7 M3 3v8h8 M12 7v5l3 2',
  plus:'M12 4v16 M4 12h16', collapse:'m15 5-7 7 7 7', close:'m6 6 12 12 M18 6 6 18', refresh:'M20 7a9 9 0 1 0 1 9 M20 2v6h-6',
  maximize:'M3 9V3h6 M15 3h6v6 M21 15v6h-6 M9 21H3v-6', file:'M5 2h9l5 5v15H5z M14 2v6h5', folder:'M3 6h6l2 2h10v12H3z'
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="ui-icon"><path d="${paths[name] || paths.file}" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
