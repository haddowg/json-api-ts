/**
 * The seed dataset for the in-memory mock backend — a handful of artists, albums, tracks and
 * playlists with ordered-track pivots. The first few rows reuse the captured fixture data
 * (OK Computer / Dummy etc.); the rest expand the catalogue so search and browse have something
 * to chew on. Shapes are plain rows; the {@link MockStore} turns them into JSON:API resources.
 */

export interface ArtistRow {
  id: string
  name: string
  slug: string
  website: string | null
  bio: string | null
  createdAt: string
}

export interface AlbumRow {
  id: string
  artistId: string
  title: string
  status: 'upcoming' | 'released' | 'withdrawn'
  releasedAt: string
  averageRating: number | null
  explicit: boolean
  artwork: string | null
  availableFrom: string | null
  availableUntil: string | null
  releaseInfo: { label?: string; catalogueNumber?: string } | null
}

export interface TrackRow {
  id: string
  albumId: string
  title: string
  trackNumber: number
  durationSeconds: number
  explicit: boolean
  genres: string[]
  previewOffset: string | null
}

export interface PlaylistRow {
  id: string
  title: string
  slug: string
  public: boolean
  externalId: string | null
}

/** A playlist→track edge carrying the writable pivot `position` (1-based). */
export interface PlaylistTrackEdge {
  playlistId: string
  trackId: string
  position: number
  addedAt: string
}

export interface SeedData {
  artists: ArtistRow[]
  albums: AlbumRow[]
  tracks: TrackRow[]
  playlists: PlaylistRow[]
  playlistTracks: PlaylistTrackEdge[]
}

export const PLAYLIST_ID = '00000000-0000-4000-8000-000000000001'
const PLAYLIST_ID_2 = '00000000-0000-4000-8000-000000000002'

export function createSeed(): SeedData {
  const artists: ArtistRow[] = [
    {
      id: '1',
      name: 'Radiohead',
      slug: 'radiohead',
      website: 'https://radiohead.com',
      bio: 'An English rock band formed in Abingdon.',
      createdAt: '2001-05-01T09:00:00+00:00',
    },
    {
      id: '2',
      name: 'Portishead',
      slug: 'portishead',
      website: null,
      bio: 'A trip-hop band from Bristol.',
      createdAt: '2002-08-15T12:30:00+00:00',
    },
    {
      id: '3',
      name: 'Boards of Canada',
      slug: 'boards-of-canada',
      website: 'https://boardsofcanada.com',
      bio: 'A Scottish electronic music duo.',
      createdAt: '2003-02-11T10:00:00+00:00',
    },
    {
      id: '4',
      name: 'Aphex Twin',
      slug: 'aphex-twin',
      website: null,
      bio: 'The recording alias of Richard D. James.',
      createdAt: '2004-06-20T08:15:00+00:00',
    },
    {
      id: '5',
      name: 'Massive Attack',
      slug: 'massive-attack',
      website: 'https://massiveattack.ie',
      bio: 'A trip-hop collective from Bristol.',
      createdAt: '2005-09-30T14:45:00+00:00',
    },
  ]

  const albums: AlbumRow[] = [
    album('1', '1', 'OK Computer', 'released', '1997-05-21', 9.8, 'Parlophone', 'NODATA 01'),
    album('2', '2', 'Dummy', 'released', '1994-08-22', 9.1, 'Go! Beat', 'NODATA 02'),
    album('3', '1', 'Kid A', 'released', '2000-10-02', 9.4, 'Parlophone', 'NODATA 03'),
    album(
      '4',
      '3',
      'Music Has the Right to Children',
      'released',
      '1998-04-20',
      9.0,
      'Warp',
      'WARP 55',
    ),
    album(
      '5',
      '4',
      'Selected Ambient Works 85-92',
      'released',
      '1992-11-09',
      9.2,
      'R&S',
      'RS 9202',
    ),
    album('6', '5', 'Mezzanine', 'released', '1998-04-20', 9.3, 'Virgin', 'VIRGIN 12'),
    album('7', '3', 'Geogaddi', 'released', '2002-02-18', 8.8, 'Warp', 'WARP 101'),
    album('8', '1', 'The King of Limbs', 'released', '2011-02-18', 7.9, 'XL', 'XL 510'),
    {
      id: '9',
      artistId: '4',
      title: 'Blackbox Life Recorder 21f',
      status: 'upcoming',
      releasedAt: '2030-07-28T00:00:00+00:00',
      averageRating: null,
      explicit: false,
      artwork: null,
      availableFrom: '2030-07-28',
      availableUntil: null,
      releaseInfo: { label: 'Warp', catalogueNumber: 'WARP 999' },
    },
  ]

  // Tracks: a tracklist for OK Computer (reused), plus a couple per other album.
  const tracks: TrackRow[] = [
    track('1', '1', 'Airbag', 1, 284, false, ['rock', 'alternative'], '00:00:30'),
    track('2', '1', 'Paranoid Android', 2, 383, true, ['rock', 'progressive'], '00:01:00'),
    track('3', '1', 'Exit Music (For a Film)', 3, 264, false, ['rock'], null),
    track('4', '2', 'Mysterons', 1, 305, false, ['trip-hop'], '00:00:20'),
    track('5', '2', 'Sour Times', 2, 251, false, ['trip-hop'], '00:00:45'),
    track('6', '3', 'Everything in Its Right Place', 1, 251, false, ['electronic'], null),
    track('7', '3', 'Idioteque', 4, 318, false, ['electronic', 'idm'], '00:01:10'),
    track('8', '4', 'Roygbiv', 4, 161, false, ['idm', 'ambient'], null),
    track('9', '5', 'Xtal', 1, 293, false, ['ambient'], null),
    track('10', '6', 'Teardrop', 3, 330, false, ['trip-hop'], '00:00:50'),
    track('11', '7', 'Music Is Math', 2, 313, false, ['idm'], null),
    track('12', '8', 'Lotus Flower', 5, 299, false, ['electronic'], '00:00:40'),
  ]

  const playlists: PlaylistRow[] = [
    { id: PLAYLIST_ID, title: 'Late Night', slug: 'late-night', public: true, externalId: null },
    {
      id: PLAYLIST_ID_2,
      title: 'Focus Beats',
      slug: 'focus-beats',
      public: false,
      externalId: null,
    },
  ]

  const playlistTracks: PlaylistTrackEdge[] = [
    { playlistId: PLAYLIST_ID, trackId: '3', position: 1, addedAt: '2024-04-01T09:00:00+00:00' },
    { playlistId: PLAYLIST_ID, trackId: '1', position: 2, addedAt: '2024-04-02T09:00:00+00:00' },
    { playlistId: PLAYLIST_ID, trackId: '10', position: 3, addedAt: '2024-04-03T09:00:00+00:00' },
    { playlistId: PLAYLIST_ID_2, trackId: '6', position: 1, addedAt: '2024-05-01T09:00:00+00:00' },
    { playlistId: PLAYLIST_ID_2, trackId: '8', position: 2, addedAt: '2024-05-02T09:00:00+00:00' },
  ]

  return { artists, albums, tracks, playlists, playlistTracks }
}

function album(
  id: string,
  artistId: string,
  title: string,
  status: AlbumRow['status'],
  date: string,
  rating: number | null,
  label: string,
  cat: string,
): AlbumRow {
  return {
    id,
    artistId,
    title,
    status,
    releasedAt: `${date}T00:00:00+00:00`,
    averageRating: rating,
    explicit: false,
    artwork: null,
    availableFrom: date,
    availableUntil: '2035-12-31',
    releaseInfo: { label, catalogueNumber: cat },
  }
}

function track(
  id: string,
  albumId: string,
  title: string,
  trackNumber: number,
  durationSeconds: number,
  explicit: boolean,
  genres: string[],
  previewOffset: string | null,
): TrackRow {
  return { id, albumId, title, trackNumber, durationSeconds, explicit, genres, previewOffset }
}
