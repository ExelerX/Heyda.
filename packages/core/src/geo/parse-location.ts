import { isValidLatLon } from './types';

/**
 * Reads what people paste when they pick a destination: plain coordinates (decimal or
 * degrees/minutes/seconds), geo: URIs, and links from Google Maps, Apple Maps, OpenStreetMap
 * and Waze. Pure string work: nothing is fetched, so short links (maps.app.goo.gl, osm.org/go)
 * and addresses are not resolved and give `null`. All regexes are linear (no nested
 * quantifiers), input is capped at MAX_LOCATION_INPUT characters.
 */
export interface ParsedLocation {
  lat: number;
  lon: number;
  /** Place name carried by the link, if any. Plain text, at most 120 characters. */
  label?: string;
}

export const MAX_LOCATION_INPUT = 2000;
const MAX_LABEL = 120;
const MAX_TOKENS = 24;
const NUM = /^[+-]?\d{1,3}(?:\.\d{1,20})?$/;
const AT = /^@([+-]?\d{1,3}(?:\.\d{1,20})?),([+-]?\d{1,3}(?:\.\d{1,20})?)(?:,|$)/;
const PIN = /!3d([+-]?\d{1,3}(?:\.\d{1,20})?)!4d([+-]?\d{1,3}(?:\.\d{1,20})?)/g;
const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const OSM_HOSTS = ['openstreetmap.org', 'www.openstreetmap.org', 'osm.org', 'www.osm.org'];
const WAZE_HOSTS = ['waze.com', 'www.waze.com', 'ul.waze.com'];

export function parseLocationInput(text: string): ParsedLocation | null {
  if (typeof text !== 'string' || text.length > MAX_LOCATION_INPUT) return null;
  const s = text.trim();
  if (s === '') return null;
  if (/^geo:/i.test(s)) return parseGeoUri(s);
  // A link inside other text ("Treffpunkt: https://…") counts; the first link decides.
  const words = s.split(/\s+/);
  for (const word of words) {
    const w = words.length > 1 ? trimEnd(word, '.,') : word;
    if (/^geo:/i.test(w)) return parseGeoUri(w);
    if (/^https?:\/\//i.test(w)) return parseMapUrl(w);
  }
  if (words.length === 1 && s.includes('/')) {
    const bare = splitUrl(`https://${s}`);
    if (bare && hostKind(bare.host) !== null) return parseMapUrl(`https://${s}`);
  }
  return parseCoordinates(s);
}

// ---------------------------------------------------------------------------------------------
// Plain coordinates: "48.137, 11.575", "48,137 11,575", "N 48° 08.220 E 011° 34.500",
// 48°08'13.2"N 11°34'30.0"E. Order is lat, lon unless hemisphere letters say otherwise.

type Hemi = 'N' | 'S' | 'E' | 'W';
type Tok =
  | { k: 'num'; v: number; int: boolean; neg: boolean; signed: boolean }
  | { k: 'deg' | 'min' | 'sec' | 'sep' }
  | { k: 'hemi'; h: Hemi };
interface Group {
  v: number;
  axis?: 'lat' | 'lon';
}

const CHARS: Record<string, string> = {
  '−': '-', '–': '-', 'º': '°', '˚': '°', '′': "'", '’': "'",
  '‘': "'", '´': "'", '`': "'", '″': '"', '“': '"', '”': '"', '„': '"',
};
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c);

function tokenize(input: string): Tok[] | null {
  const s = Array.from(input, (c) => CHARS[c] ?? c).join('').toUpperCase();
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (isDigit(c) || ((c === '-' || c === '+') && isDigit(s[i + 1]))) {
      if (!isDigit(c) && (isDigit(s[i - 1]) || s[i - 1] === '.')) return null; // "48-11" is a range
      const start = i;
      if (!isDigit(c)) i++;
      while (isDigit(s[i])) i++;
      const sep = s[i];
      const decimal = (sep === '.' || sep === ',') && isDigit(s[i + 1]);
      if (decimal) {
        i++;
        while (isDigit(s[i])) i++;
      }
      const text = s.slice(start, i).replace(',', '.');
      if (!NUM.test(text)) return null;
      const v = Number(text);
      out.push({ k: 'num', v: Math.abs(v), int: !decimal, neg: text.startsWith('-'), signed: !isDigit(c) });
    } else if (c === '°') {
      out.push({ k: 'deg' });
      i++;
    } else if (c === "'") {
      const double = s[i + 1] === "'";
      out.push({ k: double ? 'sec' : 'min' });
      i += double ? 2 : 1;
    } else if (c === '"') {
      out.push({ k: 'sec' });
      i++;
    } else if (c === ',' || c === ';') {
      out.push({ k: 'sep' });
      i++;
    } else if ('NSEWO'.includes(c) && !isLetter(s[i - 1]) && !isLetter(s[i + 1])) {
      if (c === 'E' && isDigit(s[i - 1]) && isDigit(s[i + 1])) return null; // 1E5 is an exponent
      out.push({ k: 'hemi', h: c === 'O' ? 'E' : (c as Hemi) }); // O = Ost (German)
      i++;
    } else {
      return null;
    }
    if (out.length > MAX_TOKENS) return null;
  }
  return out;
}

/** True when the numbers starting at `i` are followed by a hemisphere letter. */
function hemiFollows(t: Tok[], i: number): boolean {
  let j = i;
  while (t[j] !== undefined && t[j]!.k !== 'hemi' && t[j]!.k !== 'sep') j++;
  return t[j]?.k === 'hemi';
}

function parseGroup(t: Tok[], start: number): { g: Group; next: number } | null {
  let i = start;
  let hemi: Hemi | undefined;
  const first = t[i];
  if (first?.k === 'hemi') {
    hemi = first.h;
    i++;
  }
  const d = t[i];
  if (d?.k !== 'num') return null;
  i++;
  const hasDeg = t[i]?.k === 'deg';
  if (hasDeg) i++;
  let value = d.v;
  let viaLookahead = false;
  // Minutes and seconds only where markers or hemisphere letters make them unambiguous,
  // so "48.137 11.575" stays two decimal numbers.
  const m = t[i];
  const marked = hasDeg || hemi !== undefined;
  if (d.int && m?.k === 'num' && !m.signed && t[i + 1]?.k !== 'deg' && (marked || hemiFollows(t, i))) {
    viaLookahead = !marked; // then this group has to end with that letter
    i++;
    if (t[i]?.k === 'min') i++;
    if (m.v >= 60) return null;
    value += m.v / 60;
    const sec = t[i];
    const after = t[i + 1]?.k;
    if (m.int && sec?.k === 'num' && !sec.signed && after !== 'deg' && after !== 'min') {
      i++;
      if (t[i]?.k === 'sec') i++;
      if (sec.v >= 60) return null;
      value += sec.v / 3600;
    }
  }
  const stray = t[i]?.k;
  if (stray === 'deg' || stray === 'min' || stray === 'sec') return null;
  const last = t[i];
  if (hemi === undefined && last?.k === 'hemi') {
    hemi = last.h;
    i++;
  }
  if (viaLookahead && hemi === undefined) return null;
  if (hemi !== undefined && d.signed) return null; // "-48 N": contradictory or redundant
  const negative = d.neg || hemi === 'S' || hemi === 'W';
  const axis = hemi === undefined ? undefined : hemi === 'N' || hemi === 'S' ? 'lat' : 'lon';
  return { g: { v: negative ? -value : value, ...(axis ? { axis } : {}) }, next: i };
}

function parseCoordinates(text: string): ParsedLocation | null {
  const t = tokenize(text);
  if (!t) return null;
  const a = parseGroup(t, 0);
  if (!a) return null;
  const b = parseGroup(t, t[a.next]?.k === 'sep' ? a.next + 1 : a.next);
  if (!b || b.next !== t.length) return null;
  // Without degree signs or N/S/E/W, ask for a decimal point: "10 20" or "12, 5" are no place.
  const marked = t.some((x) => x.k !== 'num' && x.k !== 'sep');
  if (!marked && !t.some((x) => x.k === 'num' && !x.int)) return null;
  let lat = a.g;
  let lon = b.g;
  if (lat.axis !== undefined && lat.axis === lon.axis) return null;
  if (lat.axis === 'lon' || lon.axis === 'lat') [lat, lon] = [lon, lat];
  return point(lat.v, lon.v);
}

// ---------------------------------------------------------------------------------------------
// geo: URIs (RFC 5870) plus the Android "geo:0,0?q=lat,lon(Label)" form.

function parseGeoUri(uri: string): ParsedLocation | null {
  let rest = uri.slice(4);
  if (rest.startsWith('//')) rest = rest.slice(2);
  const qAt = rest.indexOf('?');
  const query = parseQuery(qAt < 0 ? '' : rest.slice(qAt + 1));
  const [coords = '', ...params] = (qAt < 0 ? rest : rest.slice(0, qAt)).split(';');
  for (const p of params) {
    const [key = '', val = ''] = p.split('=');
    if (key.toLowerCase() === 'crs' && val.toLowerCase() !== 'wgs84') return null;
  }
  const q = query.get('q');
  const fromQ = q === undefined ? null : coordsWithLabel(q);
  if (fromQ) return fromQ;
  const parts = coords.split(',');
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts[2] !== undefined && !/^[+-]?\d{1,6}(?:\.\d{1,6})?$/.test(parts[2])) return null;
  const p = pair(parts[0], parts[1]);
  // geo:0,0?q=<address> asks the map app to search; we do not geocode.
  if (!p || (p.lat === 0 && p.lon === 0)) return null;
  return p;
}

// ---------------------------------------------------------------------------------------------
// Map links. Parsed by hand (no URL class: React Native's is incomplete).

interface SplitUrl {
  host: string;
  path: string;
  query: Map<string, string>;
  hash: string;
}

function splitUrl(url: string): SplitUrl | null {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) return null;
  let rest = url.slice(schemeEnd + 3);
  const hashAt = rest.indexOf('#');
  const hash = hashAt < 0 ? '' : rest.slice(hashAt + 1);
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  const qAt = rest.indexOf('?');
  const query = parseQuery(qAt < 0 ? '' : rest.slice(qAt + 1));
  if (qAt >= 0) rest = rest.slice(0, qAt);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const host = trimEnd(authority.slice(authority.lastIndexOf('@') + 1).split(':')[0] ?? '', '.').toLowerCase();
  return { host, path: slash < 0 ? '/' : rest.slice(slash), query, hash };
}

function hostKind(host: string): 'google' | 'apple' | 'osm' | 'waze' | null {
  if (GOOGLE_HOST.test(host)) return 'google';
  if (host === 'maps.apple.com') return 'apple';
  if (OSM_HOSTS.includes(host)) return 'osm';
  if (WAZE_HOSTS.includes(host)) return 'waze';
  return null; // includes short links: maps.app.goo.gl, goo.gl, osm.org/go needs osm.org (below)
}

function parseMapUrl(url: string): ParsedLocation | null {
  const u = splitUrl(url);
  if (!u) return null;
  switch (hostKind(u.host)) {
    case 'google':
      return parseGoogle(u);
    case 'apple':
      return parseApple(u);
    case 'osm':
      return parseOsm(u);
    case 'waze':
      return parseWaze(u);
    default:
      return null;
  }
}

function parseGoogle(u: SplitUrl): ParsedLocation | null {
  if (!u.host.startsWith('maps.') && !u.path.startsWith('/maps')) return null; // e.g. web search
  const segs = u.path.split('/').map((s) => decode(s) ?? s);
  const q = u.query;
  if (segs[2] === 'dir') {
    // Directions: only the destination counts, never the map view (that is the route's middle).
    const dest = q.get('destination') ?? q.get('daddr');
    if (dest !== undefined) return coordsWithLabel(dest);
    const stops = segs.slice(3).filter((s) => s !== '' && !s.startsWith('@') && !s.startsWith('data='));
    const last = stops[stops.length - 1];
    return last === undefined ? null : parseCoordinates(last);
  }
  const name = segs[2] === 'place' ? segs[3] : undefined;
  const label = name !== undefined && parseCoordinates(name) === null ? name : undefined;
  // 1. The place's own pin in the data blob (more exact than the map view).
  let pin: RegExpMatchArray | undefined;
  for (const m of (decode(u.path) ?? u.path).matchAll(PIN)) pin = m;
  if (pin) return withLabel(pair(pin[1], pin[2]), label);
  // 2. Coordinates as query. A text query is a search we cannot resolve.
  for (const key of ['q', 'query', 'destination', 'daddr']) {
    const v = q.get(key);
    if (v !== undefined) return coordsWithLabel(v);
  }
  // 3. A dropped pin: /maps/place/48°08'13.2"N+11°34'30.0"E/ or /maps/search/48.137,+11.575/
  if (segs[2] === 'place' || segs[2] === 'search') {
    const p = segs[3] ? parseCoordinates(segs[3]) : null;
    if (p) return p;
    if (segs[2] === 'search' && segs[3]) return null; // "Pizza near the map view"
  }
  // 4. The map view's centre.
  for (const key of ['ll', 'center', 'sll']) {
    const v = q.get(key);
    if (v !== undefined) return withLabel(parseCoordinates(v), label);
  }
  const at = segs.find((s) => s.startsWith('@'));
  const m = at === undefined ? null : AT.exec(at);
  return m ? withLabel(pair(m[1], m[2]), label) : null;
}

function parseApple(u: SplitUrl): ParsedLocation | null {
  const q = u.query;
  const dest = q.get('destination') ?? q.get('daddr');
  if (dest !== undefined || u.path.startsWith('/directions')) return dest === undefined ? null : coordsWithLabel(dest);
  const name = q.get('name') ?? q.get('q');
  const label = name !== undefined && parseCoordinates(name) === null ? name : undefined;
  // ll / coordinate = the place, q = its name, sll = "search near". address is never geocoded.
  for (const key of ['coordinate', 'll', 'q', 'sll']) {
    const v = q.get(key);
    const p = v === undefined ? null : coordsWithLabel(v);
    if (p) return key === 'q' ? p : withLabel(p, label);
  }
  return null;
}

function parseOsm(u: SplitUrl): ParsedLocation | null {
  const q = u.query;
  const mlat = q.get('mlat');
  const mlon = q.get('mlon');
  if (mlat !== undefined && mlon !== undefined) return pair(mlat, mlon);
  if (u.path.startsWith('/directions')) {
    const stops = (q.get('route') ?? '').split(';');
    return parseCoordinates(stops[stops.length - 1] ?? '');
  }
  for (const part of u.hash.split('&')) {
    if (!part.startsWith('map=')) continue;
    const bits = part.slice(4).split('/');
    return bits.length === 3 ? pair(bits[1], bits[2]) : null;
  }
  const lat = q.get('lat');
  const lon = q.get('lon');
  return lat !== undefined && lon !== undefined ? pair(lat, lon) : null;
}

function parseWaze(u: SplitUrl): ParsedLocation | null {
  let v = u.query.get('ll') ?? u.query.get('to');
  if (v?.startsWith('ll.')) v = v.slice(3);
  return v === undefined ? null : parseCoordinates(v);
}

// ---------------------------------------------------------------------------------------------
// Helpers

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  if (query === '') return out;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = decode(eq < 0 ? part : part.slice(0, eq));
    const val = decode(eq < 0 ? '' : part.slice(eq + 1));
    if (key !== null && val !== null && !out.has(key.toLowerCase())) out.set(key.toLowerCase(), val);
  }
  return out;
}

/** Percent-decoding with "+" as space; null for malformed escapes. */
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s.split('+').join(' '));
  } catch {
    return null;
  }
}

/** "48.137,11.575", "loc:48.137,11.575" or "48.137,11.575(Label)". */
function coordsWithLabel(value: string): ParsedLocation | null {
  let v = value.trim();
  let label: string | undefined;
  if (v.endsWith(')')) {
    const open = v.indexOf('(');
    if (open < 0) return null;
    label = v.slice(open + 1, -1);
    v = v.slice(0, open);
  }
  if (v.toLowerCase().startsWith('loc:')) v = v.slice(4);
  return withLabel(parseCoordinates(v), label);
}

function pair(lat: string | undefined, lon: string | undefined): ParsedLocation | null {
  const a = lat?.trim() ?? '';
  const b = lon?.trim() ?? '';
  return NUM.test(a) && NUM.test(b) ? point(Number(a), Number(b)) : null;
}

function point(lat: number, lon: number): ParsedLocation | null {
  if (!isValidLatLon({ lat, lon })) return null;
  const round = (v: number) => Math.round(v * 1e7) / 1e7 || 0; // ~1 cm, and no -0
  return { lat: round(lat), lon: round(lon) };
}

function withLabel(p: ParsedLocation | null, label: string | undefined): ParsedLocation | null {
  if (!p || label === undefined) return p;
  const clean = Array.from(
    label
      .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, MAX_LABEL)
    .join('')
    .trim();
  return clean === '' ? p : { ...p, label: clean };
}

function trimEnd(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}
