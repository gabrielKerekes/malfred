// Inline SVG icons for the spell bar and kill feed (no external assets).
const svg = (body) => `<svg viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  bolt: svg(`<defs><radialGradient id="i-bolt" cx=".6" cy=".4" r=".6"><stop offset="0" stop-color="#fff6c8"/><stop offset=".4" stop-color="#ffb13d"/><stop offset="1" stop-color="#e2410c"/></radialGradient>
    <linearGradient id="i-bolt-t" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a1f"/><stop offset="1" stop-color="#ff4a0c" stop-opacity="0"/></linearGradient></defs>
    <path d="M16 6 Q9 15 3 29 Q17 22 26 16 Z" fill="url(#i-bolt-t)"/><circle cx="21" cy="11" r="7" fill="url(#i-bolt)"/>`),
  seeker: svg(`<defs><radialGradient id="i-seek"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#d6b4ff"/><stop offset="1" stop-color="#a46bff" stop-opacity="0"/></radialGradient></defs>
    <path d="M16 16 m-1 0 a1.5 1.5 0 1 1 3 0 a3.5 3.5 0 1 1 -7 0 a5.5 5.5 0 1 1 11 0 a7.5 7.5 0 1 1 -15 0 a9.5 9.5 0 1 1 19 0" fill="none" stroke="#b98aff" stroke-width="2" stroke-linecap="round" opacity=".85"/>
    <circle cx="16.5" cy="16" r="6" fill="url(#i-seek)"/>`),
  shock: svg(`<circle cx="16" cy="16" r="13" fill="none" stroke="#5fb8ff" stroke-width="1.6" stroke-dasharray="4 3" opacity=".8"/>
    <circle cx="16" cy="16" r="8.5" fill="none" stroke="#9fdcff" stroke-width="2.6"/><circle cx="16" cy="16" r="4" fill="#effaff"/>
    <path d="M16 1v4M16 27v4M1 16h4M27 16h4" stroke="#dff4ff" stroke-width="2" stroke-linecap="round"/>`),
  meteor: svg(`<defs><linearGradient id="i-met" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a1f" stop-opacity="0"/><stop offset="1" stop-color="#ffb13d"/></linearGradient>
    <radialGradient id="i-rock" cx=".65" cy=".7" r=".7"><stop offset="0" stop-color="#ffd27a"/><stop offset=".35" stop-color="#c94a14"/><stop offset="1" stop-color="#2a160d"/></radialGradient></defs>
    <path d="M2 3 L22 15 L15 22 Z" fill="url(#i-met)"/><path d="M6 2 L24 18 L19 21 Z" fill="url(#i-met)" opacity=".6"/>
    <circle cx="21" cy="21" r="7.5" fill="url(#i-rock)" stroke="#1a0d07" stroke-width="1.2"/><circle cx="18.5" cy="19" r="1.6" fill="#2a160d" opacity=".6"/>`),
  blink: svg(`<circle cx="8" cy="23" r="4.5" fill="#c99bff" opacity=".35"/><path d="M10 19 Q13 7 22 9" fill="none" stroke="#e2c8ff" stroke-width="2" stroke-dasharray="3 3" stroke-linecap="round"/>
    <circle cx="23.5" cy="10" r="5.5" fill="#c99bff"/><circle cx="23.5" cy="10" r="2.5" fill="#fff"/><path d="M27 21l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z" fill="#fff"/>`),
  ward: svg(`<defs><linearGradient id="i-ward" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9f4ff"/><stop offset="1" stop-color="#3a9ed6"/></linearGradient></defs>
    <path d="M16 3 L27 7 V15 C27 22 22 27 16 29 C10 27 5 22 5 15 V7 Z" fill="url(#i-ward)" stroke="#e8fbff" stroke-width="1.4"/>
    <path d="M16 7 L23 9.5 V15 C23 19.5 20 22.6 16 24.4 Z" fill="#fff" opacity=".35"/>`),
  vigor: svg(`<defs><linearGradient id="i-vig" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a8a"/><stop offset="1" stop-color="#c41a2a"/></linearGradient></defs>
    <path d="M16 27 C6 20 3 15 3 10.5 C3 6.9 5.9 4 9.5 4 C12.2 4 14.6 5.6 16 8 C17.4 5.6 19.8 4 22.5 4 C26.1 4 29 6.9 29 10.5 C29 15 26 20 16 27Z" fill="url(#i-vig)" stroke="#ffd0d0" stroke-width="1"/>
    <ellipse cx="10" cy="10" rx="3" ry="2" fill="#fff" opacity=".45"/>`),
  swift: svg(`<path d="M11 8l8 8-8 8M18 8l8 8-8 8" fill="none" stroke="#8be05a" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M2 12h6M4 16h5M2 20h6" stroke="#c6f5a8" stroke-width="2" stroke-linecap="round" opacity=".7"/>`),
};

/** Small flame used in the kill feed between killer and victim. */
export const FEED_KILL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1c1 3 5 4.5 5 9a5 5 0 0 1-10 0c0-2.5 1.5-3.5 2-5.5 1 1.5 1 2.5 2 3C8 5 7 3 8 1z" fill="#ff8a2a"/><path d="M8 8c.5 1.5 2.5 2 2.5 4a2.5 2.5 0 0 1-5 0c0-1 .7-1.8 1-2.6.6.6 1 .9 1.5-1.4z" fill="#ffe08a"/></svg>`;
export const FEED_LAVA = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11c2-1.5 3.5 1.5 5.5 0s3.5-1.5 5 0 2.5 1 3.5 0v4H1z" fill="#ff6a14"/><path d="M5 4l2 4M9 2l1 5M12 5l-1 3" stroke="#ffb347" stroke-width="1.4" stroke-linecap="round"/></svg>`;
