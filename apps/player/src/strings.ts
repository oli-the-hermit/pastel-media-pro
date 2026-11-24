/** Every word Pastel Media Pro shows. The design system's components bring their own (labels). */
export const strings = {
  app: {
    name: 'Pastel Media Pro',
  },
  nav: {
    label: 'Main',
  },
  pages: {
    player: { label: 'Player', empty: 'Drop a song or a video here, or open one.' },
    music: { label: 'Music', empty: 'Your albums, artists and songs will live here.' },
    streaming: { label: 'Streaming', empty: 'Your films, series and clips will live here.' },
    playlists: { label: 'Playlists', empty: 'The playlists you make will live here.' },
    subtitles: { label: 'Subtitles', empty: 'The subtitles you transcribe and edit will live here.' },
  },
  player: {
    open: 'Open files',
    /** The Open dialog. */
    dialogTitle: 'Open files',
    audioFiles: 'Audio files',
    videoFiles: 'Video files',
    /** In a browser, where only the desktop app opens files. */
    browserHint: 'The desktop app opens files from your computer.',
  },
  streaming: {
    viewsLabel: 'Streaming views',
    views: {
      home: { label: 'Home', empty: 'What you watched last and what is new in your library will show here.' },
      movies: { label: 'Movies', empty: 'Your films will live here.' },
      series: { label: 'Series', empty: 'Your series will live here, season by season.' },
      clips: { label: 'Clips', empty: 'Music videos, recordings and other short videos will live here.' },
    },
  },
  topBar: {
    openMini: 'Open mini player',
    closeMini: 'Close mini player',
    help: 'Help',
  },
  help: {
    title: 'Help',
    empty: 'Help and the keyboard shortcuts arrive with the first features.',
  },
  account: {
    defaultName: 'Profile 1',
    profile: 'Profile',
    profileEmpty: 'Your name, picture and PIN will live here.',
    appearance: 'Appearance',
    settings: 'Settings',
    about: 'About',
    switchProfile: 'Switch profile',
    switchProfileLater: 'More profiles arrive in a later version.',
  },
  about: {
    version: (v: string) => `Version ${v} (alpha)`,
    description: 'A local media player for music and video. Nothing leaves your computer.',
    licenceLabel: 'Licence',
    licence: 'Pastel Media Pro is free software under the MIT licence, built on the Pastel Studio design system (MIT).',
    source: 'github.com/oli-the-hermit/pastel-media-pro',
    thirdPartyLabel: 'Third-party software',
    libmpv:
      'Media plays through libmpv and FFmpeg, under the GNU Lesser General Public License 2.1 or later. They ship as libmpv-2.dll beside the app, which you may replace with your own build. The notices say where their source code is.',
    showNotices: 'Third-party notices',
    showLgpl: 'LGPL 2.1 text',
    textMissing: 'This text could not be loaded. It is also in the app’s source repository, under apps/player/public/licenses.',
  },
  settings: {
    ariaLabel: 'Settings',
    tabs: {
      general: { label: 'General' },
      library: { label: 'Library' },
      playback: { label: 'Playback', empty: 'How music and videos play will be set here.' },
      subtitles: { label: 'Subtitles', empty: 'How subtitles look and which languages come first will be set here.' },
      transcription: { label: 'Transcription', empty: 'The speech models and where they are kept will be set here.' },
    },
  },
  general: {
    startOn: 'Start on',
    startOnHint: 'Where the app opens. Opening a file always starts on the player.',
    startPages: { player: 'Player', music: 'Music', streaming: 'Streaming', last: 'The last page you were on' },
    showStreaming: 'Show Streaming',
    showStreamingHint: 'When off, the Streaming tab is hidden and your films and series are not loaded.',
  },
  mini: {
    windowTitle: 'Pastel Media Pro · Mini player',
    empty: 'The mini player will live here.',
  },
  library: {
    reading: 'Reading your library…',
    /** A note on the media pages: the folders they come from. */
    from: (roots: string[]) => `From ${roots.join(' · ')}`,
    noFolders: 'Add a folder with your music or videos, and they will show here. Nothing in it is ever changed.',
    add: 'Add a folder',
    addTitle: 'Add a folder to your library',
    foldersLabel: 'Your library folders',
    foldersHint: 'Pastel Media Pro reads these folders and never changes them. An early version: filters and a list to check before adding come next.',
    remove: (folder: string) => `Stop reading ${folder}`,
    browserOnly: 'The desktop app adds folders from your computer.',
    failed: (reason: string) => `This folder could not be added: ${reason}`,
  },
  music: {
    albums: 'Albums',
    allAlbums: 'All albums',
    unknownArtist: 'Unknown artist',
    noAlbum: 'Songs without an album',
    unplayableMark: '(no audio)',
    albumSubtitle: (artist: string, songs: number) => `${artist} · ${songs === 1 ? '1 song' : `${songs} songs`}`,
  },
  videos: {
    allSeries: 'All series',
    allMovies: 'All films',
    film: 'Film',
    series: 'Series',
    unknownSeries: 'Unknown series',
    play: 'Play',
    /** The series' Play button: the first episode of the season shown. */
    playFrom: (season: number | null, episode: number | null) =>
      `Play ${[season != null ? `S${season}` : '', episode != null ? `E${episode}` : ''].filter(Boolean).join(' ')}`.trim(),
    season: (n: number | null) => (n == null ? 'Episodes' : n === 0 ? 'Specials' : `Season ${n}`),
    seasons: (n: number) => (n === 1 ? '1 season' : `${n} seasons`),
    seasonLabel: 'Season',
    /** An episode row: its number, then its own title when the file name gives one. */
    episodeRow: (episode: number | null, title: string | null) =>
      [episode != null ? `Episode ${episode}` : 'Episode', title].filter(Boolean).join(' · '),
    episodes: (n: number) => (n === 1 ? '1 episode' : `${n} episodes`),
  },
  playback: {
    unplayable: 'This song has no audio the player can read.',
    browser: "This browser can't play this file. The desktop app can.",
    failed: (reason: string) => `This file could not be played: ${reason}`,
  },
} as const;
