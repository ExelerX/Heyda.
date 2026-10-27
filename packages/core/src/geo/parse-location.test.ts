import { describe, expect, it } from 'vitest';
import { MAX_LOCATION_INPUT, parseLocationInput } from './parse-location';

/** Marienplatz, München. */
const LAT = 48.137;
const LON = 11.575;

const expectAt = (input: string, lat: number, lon: number, label?: string) => {
  const p = parseLocationInput(input);
  expect(p, input).not.toBeNull();
  expect(p!.lat, input).toBeCloseTo(lat, 5);
  expect(p!.lon, input).toBeCloseTo(lon, 5);
  expect(p!.label, input).toBe(label);
};

describe('parseLocationInput: plain decimal coordinates', () => {
  it.each([
    '48.137, 11.575',
    '48.137,11.575',
    '48.137 11.575',
    '  48.137 ,  11.575  ',
    '48.137;11.575',
    '48.137\n11.575',
    '+48.137 +11.575',
    '48,137 11,575',
    '48,137, 11,575',
    '48,137,11,575',
    '48,137; 11,575',
    '48.137, 11,575',
    '48.137°, 11.575°',
    '48.137° 11.575°',
    '048.137, 011.575',
  ])('reads %j', (input) => expectAt(input, LAT, LON));

  it('handles negative values and unicode minus', () => {
    expectAt('-33.8688, 151.2093', -33.8688, 151.2093);
    expectAt('−33.8688, −151.2093', -33.8688, -151.2093);
    expectAt('40.7128,-74.0060', 40.7128, -74.006);
  });

  it('accepts the range boundaries', () => {
    expectAt('90.0, 180.0', 90, 180);
    expectAt('-90.0, -180.0', -90, -180);
    expectAt('0.0, 0.0', 0, 0);
  });

  it('never returns -0', () => {
    const p = parseLocationInput('-0.0, -0.0');
    expect(Object.is(p?.lat, 0)).toBe(true);
    expect(Object.is(p?.lon, 0)).toBe(true);
  });

  it('rounds to 7 decimals', () => {
    expect(parseLocationInput('48.13700000049, 11.57500000049')).toEqual({ lat: 48.137, lon: 11.575 });
  });
});

describe('parseLocationInput: hemisphere letters', () => {
  it.each([
    '48.137 N, 11.575 E',
    '48.137N 11.575E',
    '48.137N11.575E',
    '48.137° N, 11.575° E',
    'N 48.137, E 11.575',
    'N48.137 E11.575',
    'n 48.137 e 11.575',
    '48,137° N 11,575° O', // German: O = Ost
    '11.575 E, 48.137 N', // lon first, letters say so
    'E 11.575 N 48.137',
    '48.137 N, 11.575', // second one is then the longitude
    '11.575 E, 48.137',
  ])('reads %j', (input) => expectAt(input, LAT, LON));

  it('turns S and W into negative values', () => {
    expectAt('33.8688 S, 151.2093 E', -33.8688, 151.2093);
    expectAt('40.7128 N, 74.0060 W', 40.7128, -74.006);
    expectAt('S 1.5 W 2.5', -1.5, -2.5);
  });

  it('rejects two values on the same axis', () => {
    expect(parseLocationInput('48.137 N, 11.575 N')).toBeNull();
    expect(parseLocationInput('48.137 E, 11.575 W')).toBeNull();
  });

  it('rejects a sign together with a letter', () => {
    expect(parseLocationInput('-48.137 N, 11.575 E')).toBeNull();
    expect(parseLocationInput('-48.137 S, 11.575 E')).toBeNull();
    expect(parseLocationInput('N 48.137, E -11.575')).toBeNull();
  });

  it('rejects two letters on one value and letters inside words', () => {
    expect(parseLocationInput('N 48.137 N, 11.575 E')).toBeNull();
    expect(parseLocationInput('48.137 Nord, 11.575 Ost')).toBeNull();
    expect(parseLocationInput('48.137 NE 11.575')).toBeNull();
  });
});

describe('parseLocationInput: degrees, minutes, seconds', () => {
  const lat = 48 + 8 / 60 + 13.2 / 3600;
  const lon = 11 + 34 / 60 + 30 / 3600;

  it.each([
    `48°08'13.2"N 11°34'30.0"E`,
    `48°08'13.2"N, 11°34'30.0"E`,
    `48° 08' 13.2" N, 11° 34' 30.0" E`,
    `48°08'13,2"N 11°34'30,0"E`,
    `48°08′13.2″N 11°34′30.0″E`, // prime and double prime
    `48°08’13.2”N 11°34’30.0”E`, // typographic quotes from word processors
    `48°08'13.2''N 11°34'30.0''E`, // two apostrophes as seconds
    `48º08'13.2"N 11º34'30.0"E`, // masculine ordinal instead of degree
    `N 48°08'13.2" E 11°34'30.0"`,
    `N48°08'13.2" E011°34'30.0"`,
    `48 08 13.2 N 11 34 30.0 E`,
    `11°34'30.0"E 48°08'13.2"N`,
    `48°08'13.2"N 11°34'30.0"O`,
  ])('reads %j', (input) => expectAt(input, lat, lon));

  it('reads degrees and decimal minutes (geocaching style)', () => {
    expectAt('N 48° 08.220 E 011° 34.500', 48 + 8.22 / 60, 11 + 34.5 / 60);
    expectAt(`N 48° 08.220' E 011° 34.500'`, 48 + 8.22 / 60, 11 + 34.5 / 60);
    expectAt(`48°08.220'N 11°34.500'E`, 48 + 8.22 / 60, 11 + 34.5 / 60);
    expectAt('48 08.220 N 11 34.500 E', 48 + 8.22 / 60, 11 + 34.5 / 60);
  });

  it('reads whole degrees with markers but no letters', () => {
    expectAt('48° 11°', 48, 11);
    expectAt(`48°8' 11°34'`, 48 + 8 / 60, 11 + 34 / 60);
  });

  it('handles the southern and western hemisphere', () => {
    expectAt(`33°52'07.7"S 151°12'33.5"E`, -(33 + 52 / 60 + 7.7 / 3600), 151 + 12 / 60 + 33.5 / 3600);
    expectAt(`40°42'46"N 74°00'22"W`, 40 + 42 / 60 + 46 / 3600, -(74 + 0 / 60 + 22 / 3600));
  });

  it('rejects minutes or seconds of 60 or more', () => {
    expect(parseLocationInput(`48°60'00"N 11°00'00"E`)).toBeNull();
    expect(parseLocationInput(`48°08'60"N 11°34'30"E`)).toBeNull();
  });

  it('rejects minutes after decimal degrees and stray markers', () => {
    expect(parseLocationInput(`48.5°08'N 11°34'E`)).toBeNull();
    expect(parseLocationInput(`48'N 11'E`)).toBeNull();
    expect(parseLocationInput(`48°°N 11°E`)).toBeNull();
    expect(parseLocationInput(`48°08'13"10"N 11°E`)).toBeNull();
  });

  it('rejects out-of-range DMS', () => {
    expect(parseLocationInput(`91°00'00"N 11°00'00"E`)).toBeNull();
    expect(parseLocationInput(`48°00'00"N 181°00'00"E`)).toBeNull();
  });
});

describe('parseLocationInput: plain text that is not a place', () => {
  it.each([
    '',
    '   ',
    '48.137',
    '48,137',
    '48,11', // one number with a decimal comma
    '10 20', // no decimal point, no markers
    '12, 5',
    'Marienplatz',
    'Marienplatz 1, 80331 München',
    '80331 München',
    '48.137, 11.575 Marienplatz',
    'Treffpunkt 48.137, 11.575',
    '48.137, 11.575, 12.0',
    '48.137 11.575 12.0',
    '48.137, 11.575,',
    ', 48.137, 11.575',
    '48.137,, 11.575',
    '48.137.5, 11.575',
    '48.137, 11.575.',
    '48,11.575',
    '48.1-11.5',
    '48.1 - 11.5',
    '91.0, 11.575',
    '48.137, 180.5',
    '-90.5, 0.0',
    '1000.5, 11.5',
    'NaN, NaN',
    'NaN NaN',
    'Infinity, 11.5',
    '1e1, 1e1',
    '1E5 2.5',
    '0x30, 0x0b',
    '[11.575, 48.137]',
    '(48.137, 11.575)',
    '8FWH4HPG+X5', // plus code
    '///index.home.raft', // what3words
    '48.137 11.575 ' + 'N '.repeat(5),
  ])('rejects %j', (input) => {
    expect(parseLocationInput(input)).toBeNull();
  });

  it('rejects ambiguous unmarked minutes', () => {
    // Either "48°11.575'" (only one value) or "48, 11.575" with E on the wrong one; neither is safe.
    expect(parseLocationInput('48 11.575 E')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseLocationInput(undefined as unknown as string)).toBeNull();
    expect(parseLocationInput(48 as unknown as string)).toBeNull();
  });
});

describe('parseLocationInput: geo: URIs', () => {
  it.each([
    'geo:48.137,11.575',
    'GEO:48.137,11.575',
    'geo:48.137,11.575;u=35',
    'geo:48.137,11.575,520;crs=wgs84;u=35',
    'geo:48.137,11.575;CRS=WGS84',
    'geo:48.137,11.575?z=15',
    'geo://48.137,11.575',
    'geo:0,0?q=48.137,11.575',
    'geo:0,0?q=48.137%2C11.575',
    'geo:0,0?q=loc:48.137,11.575',
    'geo:48.1,11.5?q=48.137,11.575', // q wins over the map position
    'geo:48.137,11.575?q=Marienplatz', // text query: keep the position, no label
  ])('reads %j', (input) => expectAt(input, LAT, LON));

  it('takes the label from q', () => {
    expectAt('geo:0,0?q=48.137,11.575(Marienplatz)', LAT, LON, 'Marienplatz');
    expectAt('geo:0,0?q=48.137%2C11.575%28Marien%20Platz%29', LAT, LON, 'Marien Platz');
    expectAt('geo:0,0?q=48.137,11.575(Caf%C3%A9+%26+Bar)', LAT, LON, 'Café & Bar');
    expectAt('geo:0,0?q=48.137,11.575(Café (alt))', LAT, LON, 'Café (alt)');
    expectAt('geo:0,0?q=48.137,11.575()', LAT, LON); // empty label is dropped
  });

  it('sanitises labels', () => {
    const long = 'x'.repeat(500);
    expect(parseLocationInput(`geo:0,0?q=48.137,11.575(${long})`)?.label).toHaveLength(120);
    expect(parseLocationInput('geo:0,0?q=48.137,11.575(A%0A%0DB%E2%80%AEC)')?.label).toBe('A B C');
    expect(parseLocationInput('geo:0,0?q=48.137,11.575(%20%20Mitte%20%20)')?.label).toBe('Mitte');
  });

  it.each([
    'geo:',
    'geo:abc',
    'geo:48.137',
    'geo:48.137;11.575',
    'geo:48.137,11.575,1,2',
    'geo:48.137,11.575,high',
    'geo:91,11.575',
    'geo:48.137,181',
    'geo:NaN,NaN',
    'geo:48.137,11.575;crs=utm',
    'geo:0,0', // null island is no destination someone shares on purpose
    'geo:0,0?q=Marienplatz+M%C3%BCnchen', // address: not geocoded
    'geo:0,0?q=Marienplatz(48.137,11.575)',
    'geo:0,0?q=48.137,11.575(unclosed',
    'geo:0,0?q=%E0%A4%A', // malformed escape
  ])('rejects %j', (input) => {
    expect(parseLocationInput(input)).toBeNull();
  });
});

describe('parseLocationInput: Google Maps', () => {
  it('reads the map view in the path', () => {
    expectAt('https://www.google.com/maps/@48.137,11.575,15z', LAT, LON);
    expectAt('https://www.google.de/maps/@48.137,11.575,15z?entry=ttu', LAT, LON);
    expectAt('https://www.google.com/maps/@48.137,11.575,3a,75y,90t/data=!3m6!1e1!3m4!1sabc!2e0!7i16384!8i8192', LAT, LON);
    expectAt('google.com/maps/@48.137,11.575,15z', LAT, LON);
    expectAt('www.google.co.uk/maps/@48.137,11.575,15z', LAT, LON);
  });

  it('prefers the place pin in the data blob over the map view, with the place name', () => {
    expectAt(
      'https://www.google.de/maps/place/Marienplatz,+80331+M%C3%BCnchen/@48.1373,11.5732,17z/data=!3m1!4b1!4m6!3m5!1s0x479e75f9a38c5fd9:0x10cb84a7db1987d!8m2!3d48.1373932!4d11.5754485!16s%2Fm%2F02r3wt?entry=ttu',
      48.1373932,
      11.5754485,
      'Marienplatz, 80331 München',
    );
  });

  it('reads a dropped pin', () => {
    expectAt(
      "https://www.google.com/maps/place/48%C2%B008'13.2%22N+11%C2%B034'30.0%22E/@48.1369,11.5727,17z/data=!3m1!4b1!4m4!3m3!8m2!3d48.137!4d11.575",
      LAT,
      LON,
    );
    expectAt("https://www.google.com/maps/place/48%C2%B008'13.2%22N+11%C2%B034'30.0%22E", 48 + 8 / 60 + 13.2 / 3600, 11.575);
    expectAt('https://www.google.com/maps/search/48.137,+11.575/@48.1,11.5,14z', LAT, LON);
  });

  it('uses the map view of a named place without pin', () => {
    expectAt('https://www.google.com/maps/place/Marienplatz/@48.137,11.575,17z', LAT, LON, 'Marienplatz');
  });

  it('reads query parameters', () => {
    expectAt('https://maps.google.com/?q=48.137,11.575', LAT, LON);
    expectAt('https://maps.google.com/maps?q=48.137,+11.575&z=15', LAT, LON);
    expectAt('https://www.google.com/maps?q=loc:48.137,11.575', LAT, LON);
    expectAt('https://www.google.com/maps?q=48.137,11.575(Treffpunkt)', LAT, LON, 'Treffpunkt');
    expectAt('https://www.google.com/maps?ll=48.137,11.575&z=15', LAT, LON);
    expectAt('http://maps.google.de/maps?ll=48.137,11.575', LAT, LON);
    expectAt('https://www.google.com/maps/@?api=1&map_action=map&center=48.137,11.575&zoom=15', LAT, LON);
    expectAt('https://www.google.com/maps/search/?api=1&query=48.137%2C11.575', LAT, LON);
    expectAt('https://maps.google.de/maps?daddr=48.137,11.575', LAT, LON);
    expectAt("https://maps.google.com/?q=48%C2%B008'13.2%22N+11%C2%B034'30.0%22E", 48 + 8 / 60 + 13.2 / 3600, 11.575);
  });

  it('reads the destination of directions, never the map view', () => {
    expectAt('https://www.google.com/maps/dir/?api=1&destination=48.137,11.575', LAT, LON);
    expectAt('https://www.google.com/maps/dir/48.1,11.5/48.137,11.575/@48.12,11.54,13z', LAT, LON);
    expectAt('https://www.google.com/maps/dir/Hauptbahnhof/48.137,+11.575/', LAT, LON);
    expect(parseLocationInput('https://www.google.com/maps/dir/Hauptbahnhof/Marienplatz/@48.12,11.54,13z/data=!4m2!4m1!3e0')).toBeNull();
    expect(parseLocationInput('https://www.google.com/maps/dir/?api=1&destination=Marienplatz')).toBeNull();
    expect(parseLocationInput('https://www.google.com/maps/dir//@48.12,11.54,13z')).toBeNull();
  });

  it('finds the link inside shared text', () => {
    expectAt('Treffpunkt hier: https://www.google.com/maps/@48.137,11.575,15z bis gleich!', LAT, LON);
    expectAt('Hier: https://maps.google.com/?q=48.137,11.575.', LAT, LON);
  });

  it.each([
    'https://maps.app.goo.gl/AbCdEf123', // short link: needs the network
    'https://goo.gl/maps/AbCdEf123',
    'Marienplatz\nhttps://maps.app.goo.gl/AbCdEf123',
    'maps.app.goo.gl/AbCdEf123',
    'https://g.co/kgs/AbCdEf',
    'https://www.google.com/maps?q=Marienplatz+M%C3%BCnchen', // text search
    'https://www.google.com/maps?q=Marienplatz&ll=48.137,11.575', // search, map view is not the place
    'https://www.google.com/maps/search/Pizza/@48.137,11.575,14z',
    'https://www.google.com/maps/search/?api=1&query=Marienplatz',
    'https://www.google.com/maps/place/Marienplatz/data=!4m2!3m1!1s0x479e75f9a38c5fd9:0x10cb84a7db1987d',
    'https://www.google.com/search?q=48.137,11.575', // web search, not maps
    'https://www.google.com/maps/@91,11.575,15z',
    'https://www.google.com/maps/@48.137,11.575z',
    'https://www.google.com/maps/@48.137',
    'https://www.google.com/maps',
    'https://www.google.evil.com/maps/@48.137,11.575,15z',
    'https://google.com.evil.net/maps/@48.137,11.575,15z',
    'https://www.google.com@evil.example/maps/@48.137,11.575,15z',
    'https://evil.example/maps/@48.137,11.575,15z',
    'https://evil.example/?q=48.137,11.575',
    'ftp://www.google.com/maps/@48.137,11.575,15z',
  ])('rejects %j', (input) => {
    expect(parseLocationInput(input)).toBeNull();
  });
});

describe('parseLocationInput: Apple Maps', () => {
  it('reads ll, sll, q and coordinate', () => {
    expectAt('https://maps.apple.com/?ll=48.137,11.575', LAT, LON);
    expectAt('https://maps.apple.com/?ll=48.137,11.575&q=Marienplatz&z=15', LAT, LON, 'Marienplatz');
    expectAt('https://maps.apple.com/?q=Marienplatz&sll=48.137,11.575&z=10&t=s', LAT, LON, 'Marienplatz');
    expectAt('https://maps.apple.com/?sll=48.137,11.575', LAT, LON);
    expectAt('https://maps.apple.com/?q=48.137,11.575', LAT, LON);
    expectAt('https://maps.apple.com/?daddr=48.137,11.575&dirflg=w', LAT, LON);
    expectAt('https://maps.apple.com/place?coordinate=48.137,11.575&name=Marienplatz', LAT, LON, 'Marienplatz');
    expectAt('https://maps.apple.com/directions?destination=48.137,11.575&mode=walking', LAT, LON);
  });

  it('reads a share link from the Maps app', () => {
    expectAt(
      'https://maps.apple.com/?address=Marienplatz%201,%2080331%20M%C3%BCnchen,%20Deutschland&auid=12345&ll=48.137,11.575&lsp=9902&q=Marienplatz',
      LAT,
      LON,
      'Marienplatz',
    );
  });

  it.each([
    'https://maps.apple.com/?address=Marienplatz%201,%2080331%20M%C3%BCnchen', // not geocoded
    'https://maps.apple.com/?q=Marienplatz',
    'https://maps.apple.com/?daddr=Marienplatz&ll=48.1,11.5',
    'https://maps.apple.com/directions?source=48.1,11.5',
    'https://maps.apple.com/?ll=48.137',
    'https://maps.apple.com/?ll=95,11.575',
    'https://maps.apple/p/AbCdEf', // short link
  ])('rejects %j', (input) => {
    expect(parseLocationInput(input)).toBeNull();
  });
});

describe('parseLocationInput: OpenStreetMap', () => {
  it('reads the map fragment', () => {
    expectAt('https://www.openstreetmap.org/#map=15/48.137/11.575', LAT, LON);
    expectAt('https://www.openstreetmap.org/#map=15/48.137/11.575&layers=C', LAT, LON);
    expectAt('https://openstreetmap.org/#layers=C&map=15/48.137/11.575', LAT, LON);
    expectAt('www.openstreetmap.org/#map=15/48.137/11.575', LAT, LON);
  });

  it('prefers the marker over the map view', () => {
    expectAt('https://www.openstreetmap.org/?mlat=48.137&mlon=11.575#map=12/48.0/11.0', LAT, LON);
    expectAt('https://osm.org/?mlat=48.137&mlon=11.575', LAT, LON);
  });

  it('reads old permalinks and the destination of directions', () => {
    expectAt('https://www.openstreetmap.org/?lat=48.137&lon=11.575&zoom=15', LAT, LON);
    expectAt(
      'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=48.1%2C11.5%3B48.137%2C11.575#map=13/48.12/11.54',
      LAT,
      LON,
    );
  });

  it.each([
    'https://osm.org/go/0JEmw~', // short link
    'https://www.openstreetmap.org/node/123456',
    'https://www.openstreetmap.org/#map=15/95/11.575',
    'https://www.openstreetmap.org/#map=15/48.137',
    'https://www.openstreetmap.org/#map=48.137/11.575/x/y',
    'https://www.openstreetmap.org/?mlat=48.137&mlon=abc',
    'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car#map=13/48.12/11.54',
    'https://openstreetmap.org.evil.example/#map=15/48.137/11.575',
  ])('rejects %j', (input) => {
    expect(parseLocationInput(input)).toBeNull();
  });
});

describe('parseLocationInput: Waze', () => {
  it('reads ll and to=ll.', () => {
    expectAt('https://waze.com/ul?ll=48.137,11.575&navigate=yes', LAT, LON);
    expectAt('https://www.waze.com/ul?ll=48.137%2C11.575&navigate=yes&zoom=17', LAT, LON);
    expectAt('https://www.waze.com/live-map/directions?to=ll.48.137%2C11.575', LAT, LON);
    expect(parseLocationInput('https://www.waze.com/ul?q=Marienplatz')).toBeNull();
    expect(parseLocationInput('https://www.waze.com/live-map/directions?to=place.ChIJ123')).toBeNull();
  });
});

describe('parseLocationInput: limits', () => {
  it('rejects input over the length limit', () => {
    const padded = `48.137, 11.575${' '.repeat(MAX_LOCATION_INPUT)}`;
    expect(parseLocationInput(padded)).toBeNull();
    const url = `https://www.google.com/maps/@48.137,11.575,15z?x=${'a'.repeat(MAX_LOCATION_INPUT)}`;
    expect(parseLocationInput(url)).toBeNull();
  });

  it('accepts input right at the limit', () => {
    const base = 'https://www.google.com/maps/@48.137,11.575,15z?x=';
    expectAt(base + 'a'.repeat(MAX_LOCATION_INPUT - base.length), LAT, LON);
  });

  it('stays fast on hostile input', () => {
    const hostile = [
      '1'.repeat(MAX_LOCATION_INPUT),
      '1.'.repeat(MAX_LOCATION_INPUT / 2),
      '1,'.repeat(MAX_LOCATION_INPUT / 2),
      `48°${"0'".repeat(998)}`,
      'N '.repeat(MAX_LOCATION_INPUT / 2),
      ' '.repeat(MAX_LOCATION_INPUT - 1) + 'x',
      'https://www.google.com/maps/' + '!3d1'.repeat(490),
      'https://www.google.com/maps/' + '!3d1.1!4d'.repeat(200),
      'https://www.google.com/maps/@' + '1'.repeat(1900),
      'https://www.google.com/maps/@1.' + '1'.repeat(1900),
      'geo:0,0?q=' + '('.repeat(1980) + ')',
      'geo:' + ';'.repeat(1990),
      'https://' + '.'.repeat(1990),
      'https://' + 'google.'.repeat(280) + 'com/maps/@48.1,11.5,1z',
      'https://maps.apple.com/?' + 'q=&'.repeat(660),
      'x https://' + '%'.repeat(1980),
      'a.'.repeat(999) + '/',
    ];
    for (const input of hostile) {
      const start = performance.now();
      expect(parseLocationInput(input)).toBeNull();
      expect(performance.now() - start, input.slice(0, 40)).toBeLessThan(50);
    }
  });
});
