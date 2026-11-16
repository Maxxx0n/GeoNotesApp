// URL parsing for link-style notes. React Native's URL polyfill doesn't implement getters
// like `hostname`, so this sticks to regexes.

// Share sheets often paste "Listen to … https://…" — take the first URL in the text.
// Bare "example.com/path" (no scheme) is accepted too and gets https://.
const URL_IN_TEXT = /(https?:\/\/[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?)/i;

export function extractUrl(text: string): string | null {
  const match = text.trim().match(URL_IN_TEXT)?.[0];
  if (!match) return null;
  const url = /^https?:\/\//i.test(match) ? match : `https://${match}`;
  return url.replace(/[).,!?]+$/, ''); // trailing punctuation from the surrounding sentence
}

// music.yandex.ru / .com / .by / .kz …, with an optional www.
const YANDEX_MUSIC = /^https:\/\/(?:www\.)?music\.yandex\.[a-z]{2,3}(?:\/|$)/i;

export function extractYandexMusicUrl(text: string): string | null {
  const url = extractUrl(text)?.replace(/^http:/i, 'https:');
  return url && YANDEX_MUSIC.test(url) ? url : null;
}

// Yandex Music app link for a web link: "yandexmusic://" + the web path, the same form
// Yandex's own web player uses for its "open in app" links. Covers tracks
// (album/1/track/2, track/2), albums, playlists and artists. null if there's no path.
export function yandexMusicAppUrl(webUrl: string): string | null {
  const path = webUrl
    .replace(YANDEX_MUSIC, '')
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, '');
  return path ? `yandexmusic://${path}` : null;
}
