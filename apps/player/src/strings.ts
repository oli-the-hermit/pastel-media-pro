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
    switchProfile: 'Switch profile',
    switchProfileLater: 'More profiles arrive in a later version.',
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
    episodeOf: (season: number | null, episode: number | null) =>
      [season != null ? `Season ${season}` : '', episode != null ? `Episode ${episode}` : ''].filter(Boolean).join(' · '),
    episodes: (n: number) => (n === 1 ? '1 episode' : `${n} episodes`),
  },
  playback: {
    unplayable: 'This song has no audio the player can read.',
    browser: "This browser can't play this file. The desktop app can.",
    failed: (reason: string) => `This file could not be played: ${reason}`,
  },
} as const;
