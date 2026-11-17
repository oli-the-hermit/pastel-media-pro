/** Every word Pastel Media Pro shows. The design system's components bring their own (labels). */
export const strings = {
  app: {
    name: 'Pastel Media Pro',
  },
  nav: {
    label: 'Main',
  },
  pages: {
    home: { label: 'Home', empty: 'What you played last and what is new in your library will show here.' },
    music: { label: 'Music', empty: 'Your albums, artists and songs will live here.' },
    movies: { label: 'Movies', empty: 'Your films will live here, on shelves.' },
    series: { label: 'Series', empty: 'Your series will live here, season by season.' },
    playlists: { label: 'Playlists', empty: 'The playlists you make will live here.' },
    subtitles: { label: 'Subtitles', empty: 'The subtitles you transcribe and edit will live here.' },
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
      library: { label: 'Library', empty: 'The folders your library reads will be set here.' },
      playback: { label: 'Playback', empty: 'How music and videos play will be set here.' },
      subtitles: { label: 'Subtitles', empty: 'How subtitles look and which languages come first will be set here.' },
      transcription: { label: 'Transcription', empty: 'The speech models and where they are kept will be set here.' },
    },
  },
  mini: {
    windowTitle: 'Pastel Media Pro · Mini player',
    empty: 'The mini player will live here.',
  },
} as const;
