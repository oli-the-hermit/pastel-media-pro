/* global appSection, use, find, variantOf, icon, prop, v, paint, text, iconInst, auto, fixed, fill, fillBoth, bindNum, radius, pad,
   screen, overlay, float, exists, runScreens, log, built, progress, recolor, setText, setTextAt, soft, picture, rule, elevate,
   componentsSection, ownComponent, shelve, variants, setUpAccent, useAppAccent, card */
// Pastel Media Pro's screens, for Figma: its drawer, top bar and tiles, then its desktop windows,
// built from the Pastel Studio library and re-pointed to Media Pro's accent (solar lime).
// Two kinds of screen:
//   as the app is now   sizes and wording from apps/player/src (App.tsx, shell/, media/, app.css)
//                       and apps/player/src/strings.ts
//   proposals           what was asked for on 2026-11-26 and isn't built yet: a starting point to
//                       design from, marked "(proposal)" in the name
// The albums, films, folders and files shown are made up.

const SW = 1440, SH = 900;   // the desktop window's size (apps/player/src-tauri/tauri.conf.json)
const PAGE_W = 1140;         // the page's width beside the expanded drawer
const MP = {};               // Media Pro's components, by name

// ── Small parts ──────────────────────────────────────────
async function caps(s, color, style) {
  const t = await text(s.toUpperCase(), style || 'xs/SemiBold', color || 'text/3', s);
  t.letterSpacing = { unit: 'PERCENT', value: 8 }; return t;
}
function spacer(dir) { return auto(dir || 'HORIZONTAL', 'Spacer'); }
function grow(parent, dir) { const s = spacer(dir); parent.appendChild(s); if (dir === 'VERTICAL') s.layoutSizingVertical = 'FILL'; else fill(s); return s; }
function iconButton(ic, name, size, state) { const b = use('IconButton', `Size=${size || 'sm'}, State=${state || 'Default'}`, { Icon: ic }); b.name = name || ic; return b; }
function button(label, style, size, ic) { const b = use('Button', `Style=${style || 'Secondary'}, Size=${size || 'md'}`, ic ? { Label: label, 'Show icon': true, Icon: ic } : { Label: label }); b.name = label; return b; }
// Text that wraps to its container's width
async function para(parent, s, style, color, name) {
  const t = await text(s, style || 'md/Regular', color || 'text/2', name); parent.appendChild(t); fill(t); t.textAutoResize = 'HEIGHT'; return t;
}
function component(dir, name) {
  const c = figma.createComponent(); c.name = name; c.layoutMode = dir; c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'AUTO'; c.fills = []; return c;
}
// A tile of the library's: an album cover, a poster, a wide still or a round picture
function tile(shape, title, subtitle, state) {
  const t = MP.Tile.children.find(c => c.name === `Shape=${shape}, State=${state || 'Default'}`).createInstance();
  prop(t, 'Title', title); prop(t, 'Subtitle', subtitle || ''); t.name = title; return t;
}
// A wrapping grid of tiles
function gridOf(name) {
  const g = auto('HORIZONTAL', name); g.layoutWrap = 'WRAP'; bindNum(g, 'itemSpacing', 'space/16'); bindNum(g, 'counterAxisSpacing', 'space/24'); return g;
}
// One choice of a few, as the library's SegmentedControl with as many options as given
async function segmented(labels, selected) {
  const sc = auto('HORIZONTAL', 'SegmentedControl', 'space/2'); pad(sc, 'space/4', 'space/4', 'space/4', 'space/4'); radius(sc, 'radius/pill'); sc.fills = [await paint('surface/1')];
  for (const label of labels) { const o = use('SegmentedOption', `Selected=${label === selected ? 'True' : 'False'}`, { Label: label }); o.name = label; sc.appendChild(o); }
  return sc;
}
// The proposed toolbar of a library page: its search, its chips and its sort
function toolbar(parent, opts) {
  const bar = MP.Toolbar.createInstance(); parent.appendChild(bar); fill(bar);
  const search = bar.findOne(n => n.type === 'INSTANCE' && n.name === 'Search');
  if (opts.query) { prop(search, 'Content', 'Filled'); prop(search, 'Text', opts.query); } else prop(search, 'Text', opts.search);
  for (let i = 1; i <= 4; i++) {
    const chip = bar.findOne(n => n.type === 'INSTANCE' && n.name === `Chip ${i}`);
    if (i > opts.chips.length) { chip.visible = false; continue; }
    prop(chip, 'Selected', opts.chips[i - 1] === opts.chip ? 'True' : 'False'); prop(chip, 'Label', opts.chips[i - 1]);
  }
  prop(bar.findOne(n => n.type === 'INSTANCE' && n.name === 'Sort'), 'Value', opts.sort);
  return bar;
}
// A row of titles under a heading, which scrolls sideways: more than fit are cut at the edge
async function mediaRow(title, shape, items) {
  const r = auto('VERTICAL', title, 'space/12');
  const head = auto('HORIZONTAL', 'Heading', 'space/4'); head.counterAxisAlignItems = 'CENTER'; r.appendChild(head); fill(head);
  const t = await text(title, 'lg/Bold', 'text/1', 'Title'); head.appendChild(t); fill(t);
  head.appendChild(use('TextButton', 'Tone=Default, State=Default', { Label: 'See all' }));
  head.appendChild(iconButton('ChevronLeft', 'Previous')); head.appendChild(iconButton('ChevronRight', 'Next'));
  const row = auto('HORIZONTAL', 'Titles', 'space/16'); row.clipsContent = true; r.appendChild(row); fill(row);
  for (const [name, sub, state] of items) row.appendChild(tile(shape, name, sub, state));
  return r;
}

// ══ Media Pro's own components ═══════════════════════════
async function buildComponents() {
  const sec = await componentsSection('Media Pro components');
  const have = name => ownComponent(sec, name);
  const own = async node => { await useAppAccent(node); return node; };

  // The drawer: the mark and the name, the pages in the middle, the profile at the foot (shell/pages.tsx, App.tsx)
  MP.Drawer = have('MediaProDrawer');
  if (!MP.Drawer) {
    const PAGES = [['Player', 'Play'], ['Music', 'Music'], ['Streaming', 'Monitor'], ['Playlists', 'Queue'], ['Subtitles', 'Captions']];
    const vs = [];
    for (const layout of ['Expanded', 'Rail']) {
      const exp = layout === 'Expanded';
      const c = figma.createComponent(); c.name = `Layout=${layout}`; c.layoutMode = 'VERTICAL';
      c.resize(exp ? 240 : 88, 860); c.primaryAxisSizingMode = 'FIXED'; c.counterAxisSizingMode = 'FIXED'; if (!exp) c.counterAxisAlignItems = 'CENTER';
      bindNum(c, 'width', exp ? 'size/drawer-expanded' : 'size/drawer-rail');
      pad(c, 'space/24', exp ? 'space/16' : null, 'space/16', exp ? 'space/16' : null); radius(c, 'radius/3xl'); c.fills = [await paint('drawer/bg')];
      const head = auto('HORIZONTAL', 'Head', 'space/8'); head.counterAxisAlignItems = 'CENTER'; if (exp) pad(head, null, 'space/8', null, 'space/8'); c.appendChild(head);
      const mark = auto('HORIZONTAL', 'Mark'); fixed(mark, 32, 32); mark.primaryAxisAlignItems = 'CENTER'; mark.counterAxisAlignItems = 'CENTER';
      radius(mark, 'radius/md'); mark.fills = [await paint('accent/accent')]; mark.appendChild(await iconInst('Play', 'accent/on-accent', 18)); head.appendChild(mark);
      if (exp) head.appendChild(await text('Pastel Media Pro', 'md/Bold', 'text/1', 'Name'));
      grow(c, 'VERTICAL');
      const pages = auto('VERTICAL', 'Pages', exp ? 'space/8' : 'space/12'); if (!exp) pages.counterAxisAlignItems = 'CENTER'; c.appendChild(pages); if (exp) fill(pages);
      for (const [label, ic] of PAGES) { const it = use('NavItem', `Layout=${layout}, Active=False`, { Label: label, Icon: ic }); it.name = label; pages.appendChild(it); if (exp) fill(it); }
      grow(c, 'VERTICAL');
      const acct = use('AccountMenu', `Layout=${exp ? 'Expanded' : 'Compact'}, State=Default`, { Name: 'Profile 1', Initials: 'P1' }); acct.name = 'Account'; c.appendChild(acct); if (exp) fill(acct);
      vs.push(c);
    }
    MP.Drawer = await own(variants(sec, 'MediaProDrawer', vs, 'Pastel Media Pro’s drawer: the mark and the name at the top, the pages in the middle (Player, Music, Streaming, Playlists, Subtitles; Streaming can be switched off in Settings), the profile at the foot. Expanded in a wide window, a rail otherwise. No page is active here: set Active on a page’s item.'));
  }

  // The top bar: the page's title, the imports ring while the library is being read, the mini player, Help, the window's buttons (shell/AppTopBar.tsx)
  MP.TopBar = have('MediaProTopBar');
  if (!MP.TopBar) {
    const c = figma.createComponent(); c.name = 'MediaProTopBar'; c.layoutMode = 'HORIZONTAL'; c.counterAxisAlignItems = 'CENTER';
    c.resize(PAGE_W + 40, 68); c.primaryAxisSizingMode = 'FIXED'; c.counterAxisSizingMode = 'FIXED'; bindNum(c, 'height', 'size/topbar-height');
    pad(c, null, 'space/10', null, 'space/20'); bindNum(c, 'itemSpacing', 'space/16'); c.fills = [];
    const title = await text('Music', 'xl/Bold', 'text/1', 'Title'); c.appendChild(title);
    const sp = spacer(); sp.name = 'Spacer (drags the window)'; c.appendChild(sp); fill(sp);
    const tools = auto('HORIZONTAL', 'Tools', 'space/4'); tools.counterAxisAlignItems = 'CENTER'; c.appendChild(tools);
    const ring = use('TransferIndicator', 'Attention=False', { Count: '1' }); ring.name = 'Library imports'; tools.appendChild(ring);
    tools.appendChild(iconButton('MiniPlayer', 'Open mini player', 'md')); tools.appendChild(iconButton('Help', 'Help', 'md'));
    c.appendChild(find('WindowControls').createInstance());
    title.componentPropertyReferences = { characters: c.addComponentProperty('Title', 'TEXT', 'Music') };
    ring.componentPropertyReferences = { visible: c.addComponentProperty('Show imports', 'BOOLEAN', false) };
    c.description = 'Media Pro’s title bar: the page’s title, a free space that moves the window, the library imports ring (only while folders are being read or added), the mini player, Help, the window’s buttons.';
    MP.TopBar = await own(shelve(sec, c));
  }

  // The tile of the media pages: a picture with a title and a line under it (packages/media-ui MediaTile).
  // In progress and Watched are proposals: the app keeps no history yet.
  MP.Tile = have('MediaProTile');
  if (!MP.Tile) {
    const SHAPES = { Cover: [176, 176, 'Music', 'radius/lg'], Poster: [176, 264, 'FileVideo', 'radius/lg'], Wide: [272, 153, 'FileVideo', 'radius/lg'], Round: [176, 176, 'User', 'radius/pill'] };
    const vs = [];
    for (const [shape, state] of [['Cover', 'Default'], ['Poster', 'Default'], ['Poster', 'In progress'], ['Poster', 'Watched'], ['Wide', 'Default'], ['Wide', 'In progress'], ['Round', 'Default']]) {
      const [w, h, ic, round] = SHAPES[shape];
      const c = figma.createComponent(); c.name = `Shape=${shape}, State=${state}`; c.layoutMode = 'VERTICAL'; c.resize(w, 100); c.counterAxisSizingMode = 'FIXED'; c.primaryAxisSizingMode = 'AUTO';
      bindNum(c, 'itemSpacing', 'space/8'); c.fills = []; if (shape === 'Round') c.counterAxisAlignItems = 'CENTER';
      const pic = await picture('Picture', w, h, ic, round); c.appendChild(pic);
      if (state === 'In progress') { const bar = use('ProgressBar', 'Tone=Default, Size=md'); bar.name = 'Watched so far'; pic.appendChild(bar); bar.layoutPositioning = 'ABSOLUTE'; bar.resize(w - 16, bar.height); bar.x = 8; bar.y = h - 14; }
      if (state === 'Watched') {
        const ck = auto('HORIZONTAL', 'Watched'); fixed(ck, 24, 24); ck.primaryAxisAlignItems = 'CENTER'; ck.counterAxisAlignItems = 'CENTER'; radius(ck, 'radius/pill'); ck.fills = [await paint('accent/accent')];
        ck.appendChild(await iconInst('Check', 'accent/on-accent', 14)); pic.appendChild(ck); ck.layoutPositioning = 'ABSOLUTE'; ck.x = w - 32; ck.y = 8;
      }
      const cap = auto('VERTICAL', 'Caption', 'space/2'); c.appendChild(cap); fill(cap);
      const t = await text('Polar Nights', 'sm/SemiBold', 'text/1', 'Title'); cap.appendChild(t); fill(t); t.textTruncation = 'ENDING';
      const s = await text('Aurora Collective · 9 songs', 'xs/Medium', 'text/2', 'Subtitle'); cap.appendChild(s); fill(s); s.textTruncation = 'ENDING';
      if (shape === 'Round') { t.textAlignHorizontal = 'CENTER'; s.textAlignHorizontal = 'CENTER'; }
      vs.push(c);
    }
    const set = variants(sec, 'MediaProTile', vs, 'The tile of Music and Streaming: a picture (an album’s cover, a poster 2:3, a wide still 16:9, an artist’s round picture) with a title and a line under it. Replace the placeholder with an image fill. In progress (a bar of how much was watched) and Watched (a check) are proposals.');
    const tk = set.addComponentProperty('Title', 'TEXT', 'Polar Nights'), sk = set.addComponentProperty('Subtitle', 'TEXT', 'Aurora Collective · 9 songs');
    for (const c of set.children) { c.findOne(n => n.name === 'Title').componentPropertyReferences = { characters: tk }; c.findOne(n => n.name === 'Subtitle').componentPropertyReferences = { characters: sk }; }
    MP.Tile = await own(set);
  }

  // A title's page head: the poster, what it is, its name, its facts and Play (media/VideoPages.tsx TitlePage, app.css .mp-title*)
  MP.Title = have('TitleHeader');
  if (!MP.Title) {
    const c = component('HORIZONTAL', 'TitleHeader'); c.counterAxisAlignItems = 'MAX'; bindNum(c, 'itemSpacing', 'space/24');
    c.appendChild(await picture('Poster', 180, 270, 'FileVideo', 'radius/md', 'surface/3'));
    const main = auto('VERTICAL', 'Main', 'space/8'); c.appendChild(main);
    const kind = await caps('Film', 'text/3'); kind.name = 'Kind'; main.appendChild(kind);
    const name = await text('The Long Way Round', '3xl/Bold', 'text/1', 'Name'); main.appendChild(name);
    const facts = await text('2021   ·   2 h 35 min   ·   1080p   ·   mkv', 'md/Regular', 'text/2', 'Facts'); main.appendChild(facts);
    const act = auto('HORIZONTAL', 'Actions', 'space/8'); pad(act, 'space/8', null, null, null); main.appendChild(act);
    const play = button('Play', 'Primary', 'md', 'Play'); act.appendChild(play);
    kind.componentPropertyReferences = { characters: c.addComponentProperty('Kind', 'TEXT', 'FILM') };
    name.componentPropertyReferences = { characters: c.addComponentProperty('Name', 'TEXT', 'The Long Way Round') };
    facts.componentPropertyReferences = { characters: c.addComponentProperty('Facts', 'TEXT', facts.characters) };
    c.description = 'The head of a film’s or a series’ page: the poster (180 wide, 2:3, a placeholder until there is art), what it is, its name 3xl, its facts, and Play (for a series: the first episode of the season shown).';
    MP.Title = await own(shelve(sec, c));
  }

  // ── Proposals: pieces the design system doesn't have yet ──
  // A chip that filters a list: one of a few views or states, the chosen one tinted
  MP.Chip = have('FilterChip (proposal)');
  if (!MP.Chip) {
    const vs = [];
    for (const sel of [false, true]) {
      const c = figma.createComponent(); c.name = `Selected=${sel ? 'True' : 'False'}`; c.layoutMode = 'HORIZONTAL'; c.counterAxisAlignItems = 'CENTER';
      c.resize(80, 32); c.primaryAxisSizingMode = 'AUTO'; c.counterAxisSizingMode = 'FIXED'; bindNum(c, 'height', 'size/icon-button-size-sm');
      pad(c, null, 'space/14', null, 'space/14'); radius(c, 'radius/md'); c.fills = [await paint(sel ? 'accent/container' : 'surface/2')];
      c.appendChild(await text('Albums', 'sm/SemiBold', sel ? 'accent/on-container' : 'text/1', 'Label')); vs.push(c);
    }
    const set = variants(sec, 'FilterChip (proposal)', vs, 'Proposal (the design system has no chip that can be pressed yet; its plan calls it Input/FilterChip). A chip that filters what a page shows: surface/2 at rest, the accent’s container when chosen, 32 tall, radius md.');
    const k = set.addComponentProperty('Label', 'TEXT', 'Albums');
    for (const c of set.children) c.findOne(n => n.name === 'Label').componentPropertyReferences = { characters: k };
    MP.Chip = await own(set);
  }

  // The toolbar of a library page: search with suggestions and Add to library, then the chips and the sort
  MP.Toolbar = have('LibraryToolbar (proposal)');
  if (!MP.Toolbar) {
    const c = figma.createComponent(); c.name = 'LibraryToolbar (proposal)'; c.layoutMode = 'VERTICAL'; c.resize(PAGE_W, 100); c.counterAxisSizingMode = 'FIXED'; c.primaryAxisSizingMode = 'AUTO';
    bindNum(c, 'itemSpacing', 'space/12'); c.fills = [];
    const r1 = auto('HORIZONTAL', 'Search row', 'space/12'); r1.counterAxisAlignItems = 'CENTER'; c.appendChild(r1); fill(r1);
    const search = use('Combobox', 'Variant=Search, Content=Placeholder', { Text: 'Search songs, albums, artists' }); search.name = 'Search'; r1.appendChild(search); search.resize(480, search.height);
    grow(r1);
    const add = button('Add to library', 'Tonal', 'md', 'Plus'); add.name = 'Add to library'; r1.appendChild(add);
    const r2 = auto('HORIZONTAL', 'Filters', 'space/8'); r2.counterAxisAlignItems = 'CENTER'; c.appendChild(r2); fill(r2);
    ['Songs', 'Albums', 'Artists', 'Genres'].forEach((label, i) => { const chip = MP.Chip.children[i === 1 ? 1 : 0].createInstance(); chip.name = `Chip ${i + 1}`; prop(chip, 'Label', label); r2.appendChild(chip); });
    grow(r2);
    const sort = use('Select', 'State=Default', { Value: 'Recently played' }); sort.name = 'Sort'; r2.appendChild(sort); sort.resize(220, sort.height);
    c.description = 'Proposal for Music and Streaming (items 7 and 8 of the 2026-11-26 list). First row: the search, which suggests songs, albums and artists as you type (the design system’s Combobox, variant search), and Add to library (a folder or files). Second row: chips that pick what the page lists, and the sort (Recently played, Recently added, A–Z, Z–A).';
    MP.Toolbar = await own(shelve(sec, c));
  }

  // The banner at the top of Streaming's Home: up to six titles, one at a time
  MP.Hero = have('HeroCarousel (proposal)');
  if (!MP.Hero) {
    const c = figma.createComponent(); c.name = 'HeroCarousel (proposal)'; c.layoutMode = 'VERTICAL'; c.resize(PAGE_W, 420); c.primaryAxisSizingMode = 'FIXED'; c.counterAxisSizingMode = 'FIXED';
    c.primaryAxisAlignItems = 'MAX'; pad(c, 'space/40', 'space/40', 'space/40', 'space/40'); bindNum(c, 'itemSpacing', 'space/10'); radius(c, 'radius/3xl'); c.clipsContent = true; c.fills = [await paint('surface/2')];
    const art = await iconInst('FileVideo', 'text/3', 96); art.name = 'Backdrop (give the banner an image fill)'; c.appendChild(art); art.layoutPositioning = 'ABSOLUTE'; art.x = 820; art.y = 150;
    const over = await caps('Continue watching', 'accent/text', 'xs/Bold'); over.name = 'Overline'; c.appendChild(over);
    const title = await text('The Long Way Round', '4xl/Bold', 'text/1', 'Title'); c.appendChild(title);
    const facts = await text('Season 1 · Episode 3   ·   48 min   ·   1080p', 'md/Regular', 'text/2', 'Facts'); c.appendChild(facts);
    const sum = await text('Two friends leave the city with a borrowed van and no map. 21 minutes left.', 'md/Regular', 'text/2', 'Summary'); c.appendChild(sum); sum.resize(520, 44); sum.textAutoResize = 'HEIGHT';
    const acts = auto('HORIZONTAL', 'Actions', 'space/10'); pad(acts, 'space/10', null, null, null); c.appendChild(acts);
    acts.appendChild(button('Resume', 'Primary', 'lg', 'Play')); acts.appendChild(button('Details', 'Secondary', 'lg', 'Info'));
    const pager = auto('HORIZONTAL', 'Pager', 'space/12'); pager.counterAxisAlignItems = 'CENTER'; c.appendChild(pager); pager.layoutPositioning = 'ABSOLUTE';
    const dots = auto('HORIZONTAL', 'Dots (one per title, up to six)', 'space/6'); dots.counterAxisAlignItems = 'CENTER'; pager.appendChild(dots);
    for (let i = 0; i < 6; i++) { const d = figma.createRectangle(); d.name = i === 0 ? 'Current' : 'Dot'; d.resize(i === 0 ? 18 : 6, 6); radius(d, 'radius/pill'); d.fills = [await paint(i === 0 ? 'accent/accent' : 'surface/4')]; dots.appendChild(d); }
    pager.appendChild(iconButton('ChevronLeft', 'Previous', 'md')); pager.appendChild(iconButton('ChevronRight', 'Next', 'md'));
    pager.x = PAGE_W - 40 - pager.width; pager.y = 420 - 40 - pager.height; pager.constraints = { horizontal: 'MAX', vertical: 'MAX' };
    over.componentPropertyReferences = { characters: c.addComponentProperty('Overline', 'TEXT', 'CONTINUE WATCHING') };
    title.componentPropertyReferences = { characters: c.addComponentProperty('Title', 'TEXT', 'The Long Way Round') };
    facts.componentPropertyReferences = { characters: c.addComponentProperty('Facts', 'TEXT', facts.characters) };
    sum.componentPropertyReferences = { characters: c.addComponentProperty('Summary', 'TEXT', sum.characters) };
    c.description = 'Proposal for Streaming’s Home (item 9): a banner that shows up to six suggested titles, one at a time: what is in progress first, then what was added last, then titles not watched yet. The backdrop fills it (art when there is some), with the title, its facts and its actions at the lower left, the dots and arrows at the lower right. The design system’s plan calls it HeroBanner.';
    MP.Hero = await own(shelve(sec, c));
  }

  // A stripe of titles under a heading (an example: the screens build theirs with what they show)
  if (!have('MediaRow (proposal)')) {
    const r = await mediaRow('Recently added films', 'Poster', [['The Long Way Round', '2021'], ['Paper Lanterns', '2019', 'Watched'], ['North of Nowhere', '2023'], ['Small Hours', '2018', 'In progress'], ['The Glass Orchard', '2022']]);
    r.resize(960, r.height); r.counterAxisSizingMode = 'FIXED'; r.primaryAxisSizingMode = 'AUTO';
    const c = figma.createComponentFromNode(r); c.name = 'MediaRow (proposal)';
    c.description = 'Proposal for Streaming’s Home (item 9): a heading, See all and the arrows, then a row of titles that scrolls sideways. Rows: Continue watching (started and not finished), Recently added films, Recently added series, Not watched yet, and by genre when the metadata has genres. The design system’s plan calls it MediaRow.';
    await own(shelve(sec, c));
  }

  // A playlist's tile: a mosaic of its first four covers
  MP.Playlist = have('PlaylistTile (proposal)');
  if (!MP.Playlist) {
    const c = figma.createComponent(); c.name = 'PlaylistTile (proposal)'; c.layoutMode = 'VERTICAL'; c.resize(176, 100); c.counterAxisSizingMode = 'FIXED'; c.primaryAxisSizingMode = 'AUTO'; bindNum(c, 'itemSpacing', 'space/8'); c.fills = [];
    const mosaic = auto('HORIZONTAL', 'Covers'); mosaic.layoutWrap = 'WRAP'; fixed(mosaic, 176, 176); bindNum(mosaic, 'itemSpacing', 'space/2'); bindNum(mosaic, 'counterAxisSpacing', 'space/2'); radius(mosaic, 'radius/lg'); mosaic.clipsContent = true; c.appendChild(mosaic);
    for (let i = 0; i < 4; i++) mosaic.appendChild(await picture(`Cover ${i + 1}`, 87, 87, 'Music', 'radius/2xs', i % 3 ? 'surface/2' : 'surface/3'));
    const cap = auto('VERTICAL', 'Caption', 'space/2'); c.appendChild(cap); fill(cap);
    const t = await text('Late drives', 'sm/SemiBold', 'text/1', 'Name'); cap.appendChild(t); fill(t); t.textTruncation = 'ENDING';
    const s = await text('24 songs · 1 h 38 min', 'xs/Medium', 'text/2', 'Meta'); cap.appendChild(s); fill(s); s.textTruncation = 'ENDING';
    t.componentPropertyReferences = { characters: c.addComponentProperty('Name', 'TEXT', 'Late drives') };
    s.componentPropertyReferences = { characters: c.addComponentProperty('Meta', 'TEXT', '24 songs · 1 h 38 min') };
    c.description = 'Proposal for Playlists (item 11): a playlist as a tile, its cover made of its first four songs’ covers, its name and how much is in it.';
    MP.Playlist = await own(shelve(sec, c));
  }
}

// ══ The window ═══════════════════════════════════════════
// The drawer floats at the left inside the page margin, the top bar and the page beside it (App.tsx, the design system's AppShell)
async function win(f, title, pageLabel, opts) {
  opts = opts || {};
  f.layoutMode = 'HORIZONTAL'; f.primaryAxisSizingMode = 'FIXED'; f.counterAxisSizingMode = 'FIXED';
  const nav = auto('VERTICAL', 'Nav'); pad(nav, 'space/20', null, 'space/20', 'space/20'); f.appendChild(nav); nav.layoutSizingVertical = 'FILL';
  const drawer = MP.Drawer.children.find(x => x.name === 'Layout=Expanded').createInstance(); nav.appendChild(drawer); drawer.layoutSizingVertical = 'FILL';
  const item = drawer.findOne(n => n.type === 'INSTANCE' && n.name === pageLabel); if (item) prop(item, 'Active', 'True');
  const col = auto('VERTICAL', 'Column'); f.appendChild(col); fillBoth(col);
  const top = MP.TopBar.createInstance(); col.appendChild(top); fill(top); prop(top, 'Title', title);
  if (opts.imports) prop(top, 'Show imports', true);
  const page = auto('VERTICAL', 'Page', 'space/16'); pad(page, 'space/4', 'space/20', 'space/20', 'space/20'); col.appendChild(page); fillBoth(page);
  return { top, drawer, page };
}
// A dialog: the design system's Modal, with its title, Close and a body to fill
async function modal(title, width) {
  const m = auto('VERTICAL', 'Modal'); m.resize(width || 520, 100); m.counterAxisSizingMode = 'FIXED'; m.primaryAxisSizingMode = 'AUTO'; radius(m, 'radius/3xl'); m.fills = [await paint('surface/1')]; await elevate(m);
  const head = auto('HORIZONTAL', 'Header', 'space/12'); head.counterAxisAlignItems = 'CENTER'; pad(head, 'space/22', 'space/18', 'space/6', 'space/28'); m.appendChild(head); fill(head);
  const t = await text(title, 'xl/Bold', 'text/1', 'Title'); head.appendChild(t); fill(t);
  head.appendChild(iconButton('Close', 'Close'));
  const body = auto('VERTICAL', 'Body', 'space/16'); pad(body, 'space/14', 'space/28', 'space/28', 'space/28'); m.appendChild(body); fill(body);
  return { m, body };
}
// Folder tabs with their panel, as the design system's Tabs
async function tabs(parent, labels, active) {
  const wrap = auto('VERTICAL', 'Tabs'); parent.appendChild(wrap); fill(wrap);
  const list = auto('HORIZONTAL', 'List', 'space/4'); wrap.appendChild(list);
  for (const label of labels) { const t = use('Tab', `Active=${label === active ? 'True' : 'False'}`, { Label: label }); t.name = label; list.appendChild(t); }
  const panel = auto('VERTICAL', 'Panel', 'space/20'); pad(panel, 'space/20', 'space/20', 'space/20', 'space/20'); panel.fills = [await paint('surface/2')];
  for (const k of ['topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) bindNum(panel, k, 'radius/lg');
  if (labels[0] !== active) bindNum(panel, 'topLeftRadius', 'radius/lg');
  wrap.appendChild(panel); fill(panel);
  return panel;
}
// A switch with what it does and a line of help
async function switchRow(parent, title, hint, on) {
  const row = auto('HORIZONTAL', title, 'space/16'); row.counterAxisAlignItems = 'CENTER'; parent.appendChild(row); fill(row);
  const words = auto('VERTICAL', 'Words', 'space/2'); row.appendChild(words); fill(words);
  words.appendChild(await text(title, 'md/SemiBold', 'text/1', 'Title')); await para(words, hint, 'sm/Regular', 'text/2', 'Hint');
  row.appendChild(use('Switch', `On=${on ? 'True' : 'False'}`));
  return row;
}
// A label over a control, with a line of help under it
async function field(parent, label, control, hint) {
  const f = auto('VERTICAL', label, 'space/8'); parent.appendChild(f); fill(f);
  f.appendChild(await text(label, 'sm/SemiBold', 'text/2', 'Label')); f.appendChild(control); fill(control);
  if (hint) await para(f, hint, 'xs/Medium', 'text/3', 'Hint');
  return f;
}

// ── What the pages show ──────────────────────────────────
const ALBUMS = [['Polar Nights', 'Aurora Collective · 9 songs'], ['Low Tide', 'Marta Vey · 11 songs'], ['Paper Boats', 'The Quiet Hours · 8 songs'], ['Night Bus Home', 'Okolo · 12 songs'], ['Salt and Smoke', 'Hollow Pines · 10 songs'], ['Second Summer', 'Marta Vey · 9 songs'],
  ['Static Garden', 'Okolo · 14 songs'], ['Good Weather', 'Juniper Lane · 7 songs'], ['Lanterns', 'The Quiet Hours · 10 songs'], ['Further North', 'Aurora Collective · 12 songs'], ['Hours', 'Sable · 6 songs'], ['Songs without an album', 'Unknown artist · 32 songs']];
const FILMS = [['The Long Way Round', '2021'], ['Paper Lanterns', '2019'], ['North of Nowhere', '2023'], ['Small Hours', '2018'], ['The Glass Orchard', '2022'], ['Harbour Lights', '2016'], ['A Quiet Year', '2020'], ['Tin Stars', '2014'], ['Open Water', '2017'], ['The Last Ferry', '2024'], ['Winter Apples', '2015'], ['Borrowed Time', '2022']];
const SERIES = [['Northern Line', '3 seasons'], ['The Lighthouse Keepers', '2 seasons'], ['Small Town Radio', '1 season'], ['Glasswork', '4 seasons'], ['After the Rain', '1 season'], ['Night Shift', '2 seasons']];
const SONGS = [['Northern Lights', 'Aurora Collective · Polar Nights', '3:58'], ['Low Tide', 'Marta Vey · Low Tide', '4:12'], ['Night Bus Home', 'Okolo · Night Bus Home', '5:01'], ['Salt and Smoke', 'Hollow Pines · Salt and Smoke', '3:27'],
  ['Paper Boats', 'The Quiet Hours · Paper Boats', '4:44'], ['Meltwater', 'Aurora Collective · Polar Nights', '6:03'], ['Good Weather', 'Juniper Lane · Good Weather', '2:58'], ['Second Summer', 'Marta Vey · Second Summer', '3:36'], ['Static', 'Okolo · Static Garden', '4:20']];
async function addButtons(parent) {
  const row = auto('HORIZONTAL', 'Add to library', 'space/8'); parent.appendChild(row);
  row.appendChild(button('Add a folder', 'Tonal', 'md', 'FolderPlus')); row.appendChild(button('Add files', 'Tonal', 'md', 'File'));
  return row;
}
// The track list of a page: its header, then rows with their number, title, artist and length
function trackList(parent, songs, playing) {
  const list = auto('VERTICAL', 'TrackList'); parent.appendChild(list); fill(list);
  const th = find('TrackListHeader').createInstance(); list.appendChild(th); fill(th);
  songs.forEach(([title, meta, length], i) => {
    const r = use('TrackRow', `State=${i === playing ? 'Playing' : 'Default'}`); r.name = title; list.appendChild(r); fill(r);
    setText(r, 'Number', String(i + 1)); setText(r, 'Title', title); setText(r, 'Meta', meta); setText(r, 'Length', length);
  });
  return list;
}
// Music as it is now: the two Add buttons, then the albums (media/MusicPage.tsx)
async function musicPage(page) {
  const head = auto('HORIZONTAL', 'Page head', 'space/12'); head.counterAxisAlignItems = 'CENTER'; page.appendChild(head); fill(head);
  grow(head); await addButtons(head);
  const g = gridOf('Albums'); page.appendChild(g); fillBoth(g); g.clipsContent = true;
  for (const [t, s] of ALBUMS) g.appendChild(tile('Cover', t, s));
}
// Streaming's views and the two Add buttons (media/StreamingPage.tsx)
async function streamingHead(page, view, withAdd) {
  const head = auto('HORIZONTAL', 'Views', 'space/12'); head.counterAxisAlignItems = 'CENTER'; page.appendChild(head); fill(head);
  head.appendChild(await segmented(['Home', 'Movies', 'Series', 'Clips'], view)); grow(head);
  if (withAdd) await addButtons(head);
  return head;
}
// The player page with a video: the design system's VideoPlayer filling it (media/VideoView.tsx)
function videoPage(page, state, title, overline) {
  pad(page, 'space/4', 'space/20', 'space/20', 'space/20');
  const vp = use('VideoPlayer', `State=${state}`); vp.name = 'VideoPlayer'; page.appendChild(vp); fillBoth(vp);
  if (state === 'Controls shown') { prop(vp, 'Title', title); if (overline) prop(vp, 'Overline', overline); else prop(vp, 'Show overline', false); }
  return vp;
}

// ══ Screens ══════════════════════════════════════════════
async function buildScreens() {
  await setUpAccent('media');
  await buildComponents();
  const done = async f => { await useAppAccent(f); };

  // ── As the app is now ──
  if (!exists('Player · empty')) {
    const f = await screen('Player · empty', SW, SH); const { page } = await win(f, 'Player', 'Player');
    const box = auto('VERTICAL', 'Empty', 'space/16'); box.counterAxisAlignItems = 'CENTER'; pad(box, 'space/40', null, null, null); page.appendChild(box); fill(box);
    box.appendChild(await text('Drop a song or a video here, or open one.', 'md/Regular', 'text/2', 'Message')); box.appendChild(button('Open files', 'Secondary', 'md', 'FolderOpen'));
    await done(f);
  }
  if (!exists('Player · a song playing')) {
    // The design system's MusicPlayer in its wide arrangement: the art at the left, the rest beside it, the foot under both
    const f = await screen('Player · a song playing', SW, SH); const { page } = await win(f, 'Player', 'Player');
    const c = await card(page, 'MusicPlayer', 'space/24', 'space/18'); fill(c);
    const top = auto('HORIZONTAL', 'Art and track', 'space/24'); c.appendChild(top); fill(top);
    top.appendChild(await picture('Art', 400, 400, 'Music', 'radius/2xl'));
    const side = auto('VERTICAL', 'Side', 'space/12'); top.appendChild(side); fillBoth(side);
    const head = auto('HORIZONTAL', 'Head', 'space/12'); head.counterAxisAlignItems = 'CENTER'; side.appendChild(head); fill(head);
    head.appendChild(use('Chip', 'Tone=Default', { Label: 'Polar Nights', 'Show icon': true, Icon: 'Music' })); grow(head); head.appendChild(iconButton('More', 'More'));
    const track = auto('HORIZONTAL', 'Track', 'space/8'); side.appendChild(track); fill(track);
    const info = use('TrackInfo', 'Size=lg', { Title: 'Northern Lights', Meta: 'Aurora Collective · Polar Nights' }); track.appendChild(info); fill(info);
    track.appendChild(use('LikeButton', 'Liked=False'));
    grow(side, 'VERTICAL');
    const seek = auto('VERTICAL', 'Seek', 'space/2'); side.appendChild(seek); fill(seek);
    const sl = use('Slider', 'Size=md'); seek.appendChild(sl); fill(sl);
    const times = auto('HORIZONTAL', 'Times'); times.primaryAxisAlignItems = 'SPACE_BETWEEN'; seek.appendChild(times); fill(times);
    times.appendChild(use('MediaTime', 'Tone=Default, Size=sm', { Time: '1:24' })); times.appendChild(use('MediaTime', 'Tone=Default, Size=sm', { Time: '3:58' }));
    const tr = auto('HORIZONTAL', 'Transport'); tr.primaryAxisAlignItems = 'CENTER'; side.appendChild(tr); fill(tr); tr.appendChild(use('TransportControls', 'Size=md'));
    const foot = auto('HORIZONTAL', 'Foot', 'space/2'); foot.counterAxisAlignItems = 'CENTER'; c.appendChild(foot); fill(foot);
    foot.appendChild(find('VolumeControl').createInstance()); grow(foot);
    for (const [ic, name] of [['Shuffle', 'Shuffle'], ['Repeat', 'Repeat'], ['Queue', 'Queue']]) foot.appendChild(use('PlayerControl', 'Kind=Ghost, Size=sm', { Icon: ic }));
    await done(f);
  }
  if (!exists('Player · a video playing')) {
    const f = await screen('Player · a video playing', SW, SH); const { page } = await win(f, 'Player', 'Player');
    videoPage(page, 'Controls shown', 'The Long Way Round', 'SEASON 1 · EPISODE 3'); await done(f);
  }
  if (!exists("Player · we can't play this file")) {
    // media/PlayerPage.tsx CantPlay
    const f = await screen("Player · we can't play this file", SW, SH); const { page } = await win(f, 'Player', 'Player');
    const box = auto('VERTICAL', 'Cannot play', 'space/12'); box.counterAxisAlignItems = 'CENTER'; pad(box, 'space/40', null, null, null); page.appendChild(box); fill(box);
    box.appendChild(await iconInst('Warning', 'status/warning', 32));
    box.appendChild(await text("We can't play this file", 'lg/Bold', 'text/1', 'Title')); box.appendChild(await text('holiday_2009.wmv', 'md/Regular', 'text/2', 'File'));
    box.appendChild(use('TextButton', 'Tone=Default, State=Default', { Label: 'Details' })); box.appendChild(button('Open files', 'Secondary', 'md', 'FolderOpen'));
    await done(f);
  }
  if (!exists('Music · albums')) {
    const f = await screen('Music · albums', SW, SH); const { page } = await win(f, 'Music', 'Music'); await musicPage(page); await done(f);
  }
  if (!exists('Music · an album')) {
    // media/MusicPage.tsx OpenAlbum: back to all albums, then the design system's AlbumPage
    const f = await screen('Music · an album', SW, SH); const { page } = await win(f, 'Music', 'Music');
    const back = auto('HORIZONTAL', 'Back'); page.appendChild(back); back.appendChild(button('All albums', 'Secondary', 'sm', 'Back'));
    const ap = find('AlbumPage').createInstance(); page.appendChild(ap); fill(ap); await done(f);
  }
  if (!exists('Streaming · Movies')) {
    const f = await screen('Streaming · Movies', SW, SH); const { page } = await win(f, 'Streaming', 'Streaming'); pad(page, 'space/4', 'space/20', 'space/20', 'space/20'); bindNum(page, 'itemSpacing', 'space/24');
    await streamingHead(page, 'Movies', true);
    const g = gridOf('Films'); page.appendChild(g); fillBoth(g); g.clipsContent = true;
    for (const [t, y] of FILMS) g.appendChild(tile('Poster', t, y));
    await done(f);
  }
  if (!exists('Streaming · a film')) {
    // media/VideoPages.tsx TitlePage
    const f = await screen('Streaming · a film', SW, SH); const { page } = await win(f, 'Streaming', 'Streaming'); bindNum(page, 'itemSpacing', 'space/24');
    await streamingHead(page, 'Movies', false);
    const back = auto('HORIZONTAL', 'Back'); page.appendChild(back); back.appendChild(button('All films', 'Secondary', 'sm', 'Back'));
    page.appendChild(MP.Title.createInstance()); await done(f);
  }
  if (!exists('Streaming · a series')) {
    // media/VideoPages.tsx SeriesTitle: the head, the season to show, its episodes
    const f = await screen('Streaming · a series', SW, SH); const { page } = await win(f, 'Streaming', 'Streaming'); bindNum(page, 'itemSpacing', 'space/24');
    await streamingHead(page, 'Series', false);
    const back = auto('HORIZONTAL', 'Back'); page.appendChild(back); back.appendChild(button('All series', 'Secondary', 'sm', 'Back'));
    const th = MP.Title.createInstance(); page.appendChild(th); prop(th, 'Kind', 'SERIES'); prop(th, 'Name', 'Northern Line'); prop(th, 'Facts', '3 seasons   ·   26 episodes'); prop(th.findOne(n => n.type === 'INSTANCE' && n.name === 'Play'), 'Label', 'Play S1 E1');
    const eps = auto('VERTICAL', 'Episodes', 'space/12'); page.appendChild(eps); fill(eps);
    const season = use('Select', 'State=Default', { Value: 'Season 1' }); eps.appendChild(season); season.resize(200, season.height);
    const rows = auto('VERTICAL', 'Rows', 'space/4'); eps.appendChild(rows); fill(rows);
    for (const [n, t, len] of [[1, 'The 6:42', '48 min'], [2, 'Signal Failure', '51 min'], [3, 'Mind the Gap', '47 min'], [4, 'Night Service', '52 min']]) {
      const r = use('ListRow', 'State=Default', { Title: `Episode ${n} · ${t}`, Description: len, Icon: 'Play' }); r.name = `Episode ${n}`; rows.appendChild(r); fill(r);
    }
    await done(f);
  }
  if (!exists('Playlists · empty')) {
    const f = await screen('Playlists · empty', SW, SH); const { page } = await win(f, 'Playlists', 'Playlists');
    const e = use('EmptyState', null, { Message: 'The playlists you make will live here.', 'Show icon': false }); page.appendChild(e); fill(e); await done(f);
  }
  if (!exists('Settings · General')) {
    // shell/SettingsView.tsx: Start on, Show Streaming
    const f = await screen('Settings · General', SW, SH); const { page } = await win(f, 'Player', 'Player');
    const { m, body } = await modal('Settings', 620);
    const panel = await tabs(body, ['General', 'Library', 'Playback', 'Subtitles', 'Transcription'], 'General');
    await field(panel, 'Start on', use('Select', 'State=Default', { Value: 'Player' }), 'Where the app opens. Opening a file always starts on the player.');
    await switchRow(panel, 'Show Streaming', 'When off, the Streaming tab is hidden and your films and series are not loaded.', true);
    await overlay(f, m); await done(f);
  }
  if (!exists('Settings · Library')) {
    // media/LibraryFolders.tsx LibraryFoldersSettings: the folders, what each holds, check and remove; then adding
    const f = await screen('Settings · Library', SW, SH); const { page } = await win(f, 'Player', 'Player');
    const { m, body } = await modal('Settings', 620);
    const panel = await tabs(body, ['General', 'Library', 'Playback', 'Subtitles', 'Transcription'], 'Library');
    const folders = auto('VERTICAL', 'Your library folders', 'space/8'); panel.appendChild(folders); fill(folders);
    folders.appendChild(await text('Your library folders', 'sm/SemiBold', 'text/2', 'Label'));
    for (const [path, facts] of [['E:\\Music', '4,812 files · Music'], ['F:\\Video\\Films', '312 files · Movies & series'], ['F:\\Video\\Series', "1,104 files · 3 can't be found · Movies & series"]]) {
      const row = auto('HORIZONTAL', path, 'space/12'); row.counterAxisAlignItems = 'CENTER'; folders.appendChild(row); fill(row);
      const words = auto('VERTICAL', 'Folder', 'space/2'); row.appendChild(words); fill(words);
      words.appendChild(await text(path, 'md/Regular', 'text/1', 'Path')); words.appendChild(await text(facts, 'xs/Medium', 'text/2', 'Facts'));
      row.appendChild(iconButton('Refresh', 'Check for changes')); row.appendChild(iconButton('Trash', 'Remove from the library'));
    }
    await para(folders, 'Pastel Media Pro reads these folders and never changes them. It checks them for new files each time you open Music or Streaming.', 'xs/Medium', 'text/3', 'Hint');
    const acts = auto('HORIZONTAL', 'Actions', 'space/8'); acts.counterAxisAlignItems = 'CENTER'; panel.appendChild(acts); fill(acts);
    acts.appendChild(button('Add a folder', 'Tonal', 'md', 'FolderPlus')); acts.appendChild(button('Add files', 'Tonal', 'md', 'File')); grow(acts);
    acts.appendChild(use('TextButton', 'Tone=Default, State=Default', { Label: 'Check all for changes' }));
    await switchRow(panel, 'Show the files before adding them', 'A list of what was found, to check and leave things out before they are added.', true);
    await overlay(f, m); await done(f);
  }
  if (!exists('Add a folder · the files found')) {
    // media/import/ImportFlow.tsx and ReviewList.tsx: the filters, the list with its checks, then Add
    const f = await screen('Add a folder · the files found', SW, SH); const { page } = await win(f, 'Streaming', 'Streaming'); await streamingHead(page, 'Movies', true);
    const { m, body } = await modal('Add Films', 980); bindNum(body, 'itemSpacing', 'space/12');
    const selects = auto('HORIZONTAL', 'Keep', 'space/8'); selects.counterAxisAlignItems = 'CENTER'; body.appendChild(selects); fill(selects);
    selects.appendChild(await text('Keep', 'sm/SemiBold', 'text/2', 'Label'));
    for (const val of ['Videos', '20 minutes or longer', 'Any size', '720p or better']) { const s = use('Select', 'State=Default', { Value: val }); s.name = val; selects.appendChild(s); fill(s); }
    const checks = auto('HORIZONTAL', 'Checks', 'space/20'); checks.counterAxisAlignItems = 'CENTER'; body.appendChild(checks); fill(checks);
    const check = async (label, on) => { const c = auto('HORIZONTAL', label, 'space/8'); c.counterAxisAlignItems = 'CENTER'; c.appendChild(use('Checkbox', `Checked=${on ? 'True' : 'False'}`)); c.appendChild(await text(label, 'sm/Regular', 'text/1', 'Label')); return c; };
    checks.appendChild(await check('Leave out samples, trailers and extras', true)); checks.appendChild(await check("Hide what's already in the library", false)); grow(checks);
    for (const [ext, n] of [['mkv', 96], ['mp4', 28], ['avi', 4]]) checks.appendChild(await check(`${ext} (${n})`, true));
    body.appendChild(await text('128 files found   ·   124 shown · 120 checked', 'sm/Regular', 'text/2', 'Status'));
    const table = auto('VERTICAL', 'Files found'); radius(table, 'radius/lg'); table.fills = [await paint('surface/2')]; table.clipsContent = true; body.appendChild(table); fill(table);
    const line = async (cells, headRow, on) => {
      const r = auto('HORIZONTAL', headRow ? 'Head' : cells[0], 'space/12'); r.counterAxisAlignItems = 'CENTER'; pad(r, 'space/8', 'space/16', 'space/8', 'space/12'); table.appendChild(r); fill(r);
      r.appendChild(use('Checkbox', `Checked=${headRow ? 'Mixed' : on ? 'True' : 'False'}`));
      const name = auto('VERTICAL', 'Name', 'space/2'); r.appendChild(name); fill(name);
      name.appendChild(await text(cells[0], headRow ? 'xs/SemiBold' : 'sm/Medium', headRow ? 'text/3' : 'text/1', 'File')); if (cells[1]) name.appendChild(await text(cells[1], 'xs/Medium', 'text/3', 'Folder'));
      for (const cell of cells.slice(2)) { const t = await text(cell, headRow ? 'xs/SemiBold' : 'sm/Regular', headRow ? 'text/3' : 'text/2', 'Cell'); t.textAlignHorizontal = 'RIGHT'; r.appendChild(t); t.resize(88, t.height); }
    };
    await line(['Name', '', 'Length', 'Size', 'Picture'], true);
    for (const [n, folder, len, size, pic, on] of [['The Long Way Round (2021).mkv', 'The Long Way Round (2021)', '2:35:04', '8.4 GB', '1080p', true], ['Paper Lanterns (2019).mkv', 'Paper Lanterns (2019)', '1:48:22', '4.1 GB', '1080p', true],
      ['North of Nowhere (2023).mkv', 'North of Nowhere (2023)', '2:02:51', '14.2 GB', '4K', true], ['Small Hours (2018).mp4', 'Small Hours (2018)', '1:36:10', '2.2 GB', '720p', true],
      ['Harbour Lights (2016).avi', 'In your library', '1:52:40', '1.4 GB', '720p', false], ['A Quiet Year (2020).mkv', 'A Quiet Year (2020)', '—', '5.0 GB', '1080p', true]]) await line([n, folder, len, size, pic], false, on);
    const foot = auto('HORIZONTAL', 'Footer', 'space/8'); foot.counterAxisAlignItems = 'CENTER'; pad(foot, 'space/8', null, null, null); body.appendChild(foot); fill(foot);
    foot.appendChild(await check('Show this list before adding', true)); grow(foot); foot.appendChild(button('Cancel', 'Secondary', 'md')); foot.appendChild(button('Add 120', 'Primary', 'md'));
    await overlay(f, m); await done(f);
  }
  if (!exists('Library · adding a folder')) {
    // media/import/ImportQueue.tsx: the design system's TransferCard over the page, the ring in the top bar
    const f = await screen('Library · adding a folder', SW, SH); const { page } = await win(f, 'Music', 'Music', { imports: true }); await musicPage(page);
    const tc = find('TransferCard').createInstance(); tc.name = 'Import queue'; setText(tc, 'Name', 'Library');
    const rows = tc.findAll(n => n.type === 'INSTANCE' && /^State=/.test(n.name));
    if (rows[0]) prop(rows[0], 'Title', 'Adding Films'); if (rows[1]) rows[1].visible = false; if (rows[2]) prop(rows[2], 'Title', 'Checking your folders');
    float(f, tc, SW - tc.width - 36, 88); await done(f);
  }
  if (!exists('About')) {
    // shell/AboutView.tsx
    const f = await screen('About', SW, SH); const { page } = await win(f, 'Player', 'Player');
    const { m, body } = await modal('About', 620);
    const id = auto('HORIZONTAL', 'App', 'space/12'); id.counterAxisAlignItems = 'CENTER'; body.appendChild(id);
    const mark = auto('HORIZONTAL', 'Mark'); fixed(mark, 48, 48); mark.primaryAxisAlignItems = 'CENTER'; mark.counterAxisAlignItems = 'CENTER'; radius(mark, 'radius/lg'); mark.fills = [await paint('accent/accent')]; mark.appendChild(await iconInst('Play', 'accent/on-accent', 24)); id.appendChild(mark);
    const nm = auto('VERTICAL', 'Name', 'space/2'); id.appendChild(nm); nm.appendChild(await text('Pastel Media Pro', 'lg/Bold', 'text/1', 'Name')); nm.appendChild(await text('Version 0.1.0 (alpha)', 'sm/Regular', 'text/2', 'Version'));
    await para(body, 'A local media player for music and video. Nothing leaves your computer.');
    body.appendChild(await text('Licence', 'sm/SemiBold', 'text/2', 'Licence label')); await para(body, 'Pastel Media Pro is free software under the MIT licence, built on the Pastel Studio design system (MIT).', 'sm/Regular');
    body.appendChild(use('TextButton', 'Tone=Accent, State=Default', { Label: 'github.com/oli-the-hermit/pastel-media-pro' }));
    body.appendChild(await text('Third-party software', 'sm/SemiBold', 'text/2', 'Third-party label'));
    await para(body, 'Media plays through libmpv and FFmpeg, under the GNU Lesser General Public License 2.1 or later. They ship as libmpv-2.dll beside the app, which you may replace with your own build. The notices say where their source code is.', 'sm/Regular');
    const links = auto('HORIZONTAL', 'Texts', 'space/8'); body.appendChild(links); links.appendChild(button('Third-party notices', 'Secondary', 'sm')); links.appendChild(button('LGPL 2.1 text', 'Secondary', 'sm'));
    await overlay(f, m); await done(f);
  }
  if (!exists('Help')) {
    // shell/HelpView.tsx
    const f = await screen('Help', SW, SH); const { page } = await win(f, 'Player', 'Player');
    const { m, body } = await modal('Help', 620);
    const part = async (title, s) => { const p = auto('VERTICAL', title, 'space/4'); body.appendChild(p); fill(p); p.appendChild(await text(title, 'md/SemiBold', 'text/1', 'Title')); if (s) await para(p, s, 'sm/Regular'); return p; };
    await part('Playing files', 'Open a song or a video from Windows (Open with, or a double-click once Pastel Media Pro is your player), drop files on the window, or use Open files on the player. Several files play as one queue.');
    await part('Your library', 'Add the folders with your music and videos in Settings → Library. Music shows your albums; Streaming shows your films and series. Your files are only read, never changed.');
    const keys = await part('Keyboard shortcuts', 'While something plays, and not while you type.');
    for (const [k, what] of [['Space or K', 'Play or pause'], ['← →', 'Back or forward 5 seconds'], ['↑ ↓', 'Volume up or down'], ['M', 'Mute or unmute'], ['N  P', 'Next or previous song']]) {
      const r = auto('HORIZONTAL', what, 'space/12'); r.counterAxisAlignItems = 'CENTER'; pad(r, 'space/2', null, null, null); keys.appendChild(r); fill(r);
      const chip = use('Chip', 'Tone=Default', { Label: k }); r.appendChild(chip); r.appendChild(await text(what, 'sm/Regular', 'text/1', 'What'));
    }
    await part('Something not working?', 'Tell us at github.com/oli-the-hermit/pastel-media-pro/issues, with what you did and the file type.');
    await overlay(f, m); await done(f);
  }

  // ── Proposals: the 2026-11-26 list ──
  if (!exists('Player · the video is loading (proposal)')) {
    // Item 2: the page stays solid on the media backdrop, with a spinner, until the first frame
    const f = await screen('Player · the video is loading (proposal)', SW, SH); const { page } = await win(f, 'Player', 'Player'); videoPage(page, 'Loading'); await done(f);
  }
  if (!exists('Player · the controls are hidden (proposal)')) {
    // Item 5: after 2.6 s without the pointer moving or a key, only the picture is left
    const f = await screen('Player · the controls are hidden (proposal)', SW, SH); const { page } = await win(f, 'Player', 'Player'); videoPage(page, 'Controls hidden'); await done(f);
  }
  if (!exists('Player · welcome back (proposal)')) {
    // Item 12: the player opens paused on the last song played, with what was playing around it
    const f = await screen('Player · welcome back (proposal)', SW, SH); const { page } = await win(f, 'Player', 'Player');
    const main = auto('HORIZONTAL', 'Last played and its queue', 'space/16'); page.appendChild(main); fillBoth(main);
    const c = await card(main, 'Last played', 'space/32', 'space/16'); fillBoth(c); c.counterAxisAlignItems = 'CENTER'; c.primaryAxisAlignItems = 'CENTER';
    c.appendChild(await caps('Paused where you left it', 'accent/text', 'xs/Bold'));
    c.appendChild(await picture('Art', 320, 320, 'Music', 'radius/2xl'));
    const names = auto('VERTICAL', 'Track', 'space/4'); names.counterAxisAlignItems = 'CENTER'; c.appendChild(names);
    names.appendChild(await text('Northern Lights', '2xl/Bold', 'text/1', 'Title')); names.appendChild(await text('Aurora Collective · Polar Nights', 'md/Regular', 'text/2', 'Artist and album'));
    names.appendChild(await text('MP3 · 44 kHz · 128 kbps · Stereo', 'xs/Medium', 'text/3', 'Format'));
    const acts = auto('HORIZONTAL', 'Actions', 'space/10'); acts.counterAxisAlignItems = 'CENTER'; c.appendChild(acts);
    acts.appendChild(button('Resume at 1:24', 'Primary', 'lg', 'Play')); acts.appendChild(button('Open files', 'Secondary', 'lg', 'FolderOpen'));
    const q = find('PlayQueue').createInstance(); main.appendChild(q); q.layoutSizingVertical = 'FILL';
    const bar = find('NowPlayingBar').createInstance(); page.appendChild(bar); fill(bar);
    await done(f);
  }
  const MUSIC_CHIPS = ['Songs', 'Albums', 'Artists'];
  if (!exists('Music · albums, with search and filters (proposal)')) {
    // Item 7: the search, what to list, how to sort; item 10: no line of folder paths
    const f = await screen('Music · albums, with search and filters (proposal)', SW, SH); const { page } = await win(f, 'Music', 'Music');
    toolbar(page, { search: 'Search songs, albums, artists', chips: MUSIC_CHIPS, chip: 'Albums', sort: 'Recently played' });
    const g = gridOf('Albums'); page.appendChild(g); fillBoth(g); g.clipsContent = true;
    for (const [t, s] of ALBUMS) g.appendChild(tile('Cover', t, s));
    await done(f);
  }
  if (!exists('Music · songs (proposal)')) {
    const f = await screen('Music · songs (proposal)', SW, SH); const { page } = await win(f, 'Music', 'Music');
    toolbar(page, { search: 'Search songs, albums, artists', chips: MUSIC_CHIPS, chip: 'Songs', sort: 'Recently added' });
    const c = await card(page, 'Songs', 'space/16', 'space/8'); fillBoth(c); c.clipsContent = true; trackList(c, SONGS, 2);
    await done(f);
  }
  if (!exists('Music · artists (proposal)')) {
    const f = await screen('Music · artists (proposal)', SW, SH); const { page } = await win(f, 'Music', 'Music');
    toolbar(page, { search: 'Search songs, albums, artists', chips: MUSIC_CHIPS, chip: 'Artists', sort: 'A–Z' });
    const g = gridOf('Artists'); page.appendChild(g); fillBoth(g); g.clipsContent = true;
    for (const [n, s] of [['Aurora Collective', '2 albums · 21 songs'], ['Hollow Pines', '1 album · 10 songs'], ['Juniper Lane', '1 album · 7 songs'], ['Marta Vey', '2 albums · 20 songs'], ['Okolo', '2 albums · 26 songs'], ['Sable', '1 album · 6 songs'], ['The Quiet Hours', '2 albums · 18 songs'], ['Unknown artist', '32 songs']]) g.appendChild(tile('Round', n, s));
    await done(f);
  }
  if (!exists('Music · searching (proposal)')) {
    // The suggestions under the search: artists, albums and songs that match what is typed
    const f = await screen('Music · searching (proposal)', SW, SH); const { page } = await win(f, 'Music', 'Music');
    toolbar(page, { query: 'north', chips: MUSIC_CHIPS, chip: 'Albums', sort: 'Recently played' });
    const g = gridOf('Albums'); page.appendChild(g); fillBoth(g); g.clipsContent = true;
    for (const [t, s] of ALBUMS) g.appendChild(tile('Cover', t, s));
    const list = find('ComboboxList').createInstance(); list.name = 'Suggestions';
    const opts = list.findAll(n => n.type === 'INSTANCE' && /^Active=/.test(n.name)), groups = list.findAll(n => n.type === 'TEXT' && n.name === 'Group');
    const found = [['Northern Lights', 'Song · Aurora Collective · Polar Nights', 'Music'], ['Further North', 'Album · Aurora Collective', 'AudioTrack'], ['Northern Line', 'Series · 3 seasons', 'Monitor']];
    opts.forEach((o, i) => { if (found[i]) { prop(o, 'Label', found[i][0]); prop(o, 'Detail', found[i][1]); prop(o, 'Icon', icon(found[i][2]).id); } });
    if (groups[0]) groups[0].characters = 'SONGS'; if (groups[1]) groups[1].characters = 'ALBUMS AND MORE';
    float(f, list, 300, 120); await done(f);
  }
  if (!exists('Music · an artist (proposal)')) {
    const f = await screen('Music · an artist (proposal)', SW, SH); const { page } = await win(f, 'Music', 'Music'); bindNum(page, 'itemSpacing', 'space/24');
    const back = auto('HORIZONTAL', 'Back'); page.appendChild(back); back.appendChild(button('All artists', 'Secondary', 'sm', 'Back'));
    const head = auto('HORIZONTAL', 'Artist', 'space/24'); head.counterAxisAlignItems = 'MAX'; page.appendChild(head); fill(head);
    head.appendChild(await picture('Picture', 180, 180, 'User', 'radius/pill', 'surface/3'));
    const main = auto('VERTICAL', 'Main', 'space/8'); head.appendChild(main);
    main.appendChild(await caps('Artist', 'text/3')); main.appendChild(await text('Aurora Collective', '3xl/Bold', 'text/1', 'Name')); main.appendChild(await text('2 albums   ·   21 songs   ·   1 h 34 min', 'md/Regular', 'text/2', 'Facts'));
    const acts = auto('HORIZONTAL', 'Actions', 'space/8'); pad(acts, 'space/8', null, null, null); main.appendChild(acts); acts.appendChild(button('Play', 'Primary', 'md', 'Play')); acts.appendChild(button('Shuffle', 'Secondary', 'md', 'Shuffle'));
    page.appendChild(await text('Albums', 'lg/Bold', 'text/1', 'Albums heading'));
    const g = gridOf('Albums'); page.appendChild(g); fill(g);
    for (const [t, s] of [['Polar Nights', '2021 · 9 songs'], ['Further North', '2023 · 12 songs']]) g.appendChild(tile('Cover', t, s));
    await done(f);
  }
  if (!exists('Streaming · Home (proposal)')) {
    // Item 9: the banner, Continue watching, then rows by relevance. Taller than the window, to show the whole page.
    const f = await screen('Streaming · Home (proposal)', SW, 1560); const { page } = await win(f, 'Streaming', 'Streaming'); bindNum(page, 'itemSpacing', 'space/28');
    await streamingHead(page, 'Home', false);
    const hero = MP.Hero.createInstance(); page.appendChild(hero); fill(hero);
    const rows = [
      ['Continue watching', 'Wide', [['Northern Line', 'S1 · E3 · 21 min left', 'In progress'], ['Small Hours', '48 min left', 'In progress'], ['The Lighthouse Keepers', 'S2 · E1 · 39 min left', 'In progress'], ['Tin Stars', '1 h 12 min left', 'In progress'], ['Glasswork', 'S4 · E6 · 8 min left', 'In progress']]],
      ['Recently added films', 'Poster', FILMS.slice(0, 7).map(([t, y], i) => [t, y, i === 1 ? 'Watched' : 'Default'])],
      ['Series', 'Poster', SERIES.concat([['Low Country', '1 season']]).map(([t, s]) => [t, s])],
    ];
    for (const [title, shape, items] of rows) { const r = await mediaRow(title, shape, items); page.appendChild(r); fill(r); }
    await done(f);
  }
  const WATCH_CHIPS = ['All', 'Not watched', 'In progress', 'Watched'];
  for (const [view, search, items, shape] of [['Movies', 'Search films', FILMS, 'Poster'], ['Series', 'Search series', SERIES.concat(SERIES.map(([t, s]) => [`${t} II`, s])), 'Poster'],
    ['Clips', 'Search clips', [['Live at the Roundhouse', '12:40'], ['Okolo: Static (video)', '4:20'], ['Rehearsal, March', '26:12'], ['Marta Vey: Low Tide', '4:12'], ['Sound check', '8:03'], ['Back garden session', '17:55'], ['Interview, part 1', '21:30'], ['Interview, part 2', '19:08']], 'Wide']]) {
    const name = `Streaming · ${view}, with search and filters (proposal)`;
    if (exists(name)) continue;
    // Item 8: the same toolbar as Music's, with what suits videos
    const f = await screen(name, SW, SH); const { page } = await win(f, 'Streaming', 'Streaming'); bindNum(page, 'itemSpacing', 'space/20');
    await streamingHead(page, view, false);
    toolbar(page, { search, chips: WATCH_CHIPS, chip: 'All', sort: 'Recently added' });
    const g = gridOf(view); page.appendChild(g); fillBoth(g); g.clipsContent = true;
    items.forEach(([t, s], i) => g.appendChild(tile(shape, t, s, shape === 'Poster' && i === 1 ? 'Watched' : i === 3 ? 'In progress' : 'Default')));
    await done(f);
  }
  const PLAYLISTS = [['Late drives', '24 songs · 1 h 38 min'], ['Mornings', '18 songs · 1 h 06 min'], ['Focus', '41 songs · 2 h 51 min'], ['Kitchen', '32 songs · 2 h 02 min'], ['For the road north', '15 songs · 58 min']];
  const playlistsPage = async page => {
    const head = auto('HORIZONTAL', 'Page head', 'space/12'); head.counterAxisAlignItems = 'CENTER'; page.appendChild(head); fill(head);
    const search = use('SearchField', 'Filled=False', { Placeholder: 'Search playlists' }); head.appendChild(search); search.resize(360, search.height); grow(head);
    head.appendChild(button('New playlist', 'Primary', 'md', 'Plus'));
    const g = gridOf('Playlists'); page.appendChild(g); fillBoth(g); g.clipsContent = true;
    for (const [n, m] of PLAYLISTS) { const t = MP.Playlist.createInstance(); prop(t, 'Name', n); prop(t, 'Meta', m); t.name = n; g.appendChild(t); }
  };
  if (!exists('Playlists (proposal)')) {
    // Item 11: the playlists as tiles, and making one right there
    const f = await screen('Playlists (proposal)', SW, SH); const { page } = await win(f, 'Playlists', 'Playlists'); await playlistsPage(page); await done(f);
  }
  if (!exists('Playlists · a new playlist (proposal)')) {
    const f = await screen('Playlists · a new playlist (proposal)', SW, SH); const { page } = await win(f, 'Playlists', 'Playlists'); await playlistsPage(page);
    const { m, body } = await modal('New playlist', 520);
    await field(body, 'Name', use('TextInput', 'State=Default, Content=Filled', { Value: 'Sunday records' }));
    await field(body, 'Description', use('TextArea', 'Content=Placeholder', { Placeholder: 'What it is for (you can leave this empty)' }));
    const acts = auto('HORIZONTAL', 'Actions', 'space/8'); acts.primaryAxisAlignItems = 'MAX'; body.appendChild(acts); fill(acts);
    acts.appendChild(button('Cancel', 'Secondary', 'md')); acts.appendChild(button('Create', 'Primary', 'md'));
    await overlay(f, m); await done(f);
  }
  if (!exists('Playlists · a playlist (proposal)')) {
    const f = await screen('Playlists · a playlist (proposal)', SW, SH); const { page } = await win(f, 'Playlists', 'Playlists');
    const back = auto('HORIZONTAL', 'Back'); page.appendChild(back); back.appendChild(button('All playlists', 'Secondary', 'sm', 'Back'));
    const c = await card(page, 'Playlist', 'space/28', 'space/28'); fillBoth(c); c.clipsContent = true;
    const head = auto('HORIZONTAL', 'Head', 'space/24'); head.counterAxisAlignItems = 'MAX'; c.appendChild(head); fill(head);
    const cover = MP.Playlist.createInstance(); const mosaic = cover.findOne(n => n.name === 'Covers');
    head.appendChild(cover); cover.findOne(n => n.name === 'Caption').visible = false; if (mosaic) soft(() => { mosaic.resize(176, 176); });
    const main = auto('VERTICAL', 'Main', 'space/8'); head.appendChild(main);
    main.appendChild(await caps('Playlist', 'text/3')); main.appendChild(await text('Late drives', '3xl/Bold', 'text/1', 'Name')); main.appendChild(await text('24 songs   ·   1 h 38 min', 'md/Regular', 'text/2', 'Facts'));
    const acts = auto('HORIZONTAL', 'Actions', 'space/8'); acts.counterAxisAlignItems = 'CENTER'; pad(acts, 'space/8', null, null, null); main.appendChild(acts);
    acts.appendChild(button('Play', 'Primary', 'md', 'Play')); acts.appendChild(button('Shuffle', 'Secondary', 'md', 'Shuffle')); acts.appendChild(button('Add songs', 'Secondary', 'md', 'PlaylistAdd')); acts.appendChild(iconButton('More', 'More', 'md'));
    trackList(c, SONGS.slice(0, 7), 0);
    await done(f);
  }
}

runScreens('Pastel Media Pro', buildScreens);
