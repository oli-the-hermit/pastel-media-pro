// Generates a synthetic media test corpus into ./corpus (git-ignored) with ffmpeg.
// Everything is made from test signals, so nothing copyrighted is involved.
// Usage: node scripts/corpus/generate.ts [--only audio|video|tracks|names|series]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'corpus');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

type Result = { name: string; ok: boolean; size?: number; note?: string };
const results: Result[] = [];

function ffmpeg(name: string, path: string, args: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (run.status === 0 && existsSync(path)) {
    results.push({ name, ok: true, size: statSync(path).size });
  } else {
    results.push({ name, ok: false, note: (run.stderr || run.error?.message || '').trim().split('\n').pop() });
  }
}

const tone = (hz: number, secs: number) => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${secs}:sample_rate=48000`];
const picture = (secs: number, size = '640x360') => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${secs}`];
const tags = (title: string, artist = 'Test Artist', album = 'Test Album') =>
  ['-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album=${album}`];

function audio(): void {
  const d = join(out, 'audio');
  const base = (codec: string[], file: string, extra: string[] = []) =>
    ffmpeg(file, join(d, file), [...tone(440, 10), ...codec, ...tags(file), ...extra]);
  base(['-c:a', 'libmp3lame', '-b:a', '192k'], 'tone-mp3.mp3');
  base(['-c:a', 'aac', '-b:a', '128k'], 'tone-aac.m4a');
  base(['-c:a', 'alac'], 'tone-alac.m4a');
  base(['-c:a', 'flac'], 'tone-flac.flac');
  base(['-c:a', 'libopus', '-b:a', '96k'], 'tone-opus.opus');
  base(['-c:a', 'libvorbis', '-q:a', '4'], 'tone-vorbis.ogg');
  base(['-c:a', 'pcm_s16le'], 'tone-wav.wav');
  base(['-c:a', 'wmav2', '-b:a', '128k'], 'tone-wma.wma');
  base(['-c:a', 'ac3', '-b:a', '192k'], 'tone-ac3.ac3');
  base(['-c:a', 'dca', '-strict', '-2', '-b:a', '768k'], 'tone-dts.dts');
  // Two files that continue one sine wave: played back to back they must not click or gap.
  ffmpeg('gapless-a.flac', join(d, 'gapless', '01-gapless-a.flac'), [
    ...tone(440, 5), '-c:a', 'flac', ...tags('Gapless A', 'Gapless', 'Gapless'), '-metadata', 'track=1',
  ]);
  ffmpeg('gapless-b.flac', join(d, 'gapless', '02-gapless-b.flac'), [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=48000', '-af', 'asetpts=PTS-STARTPTS',
    '-c:a', 'flac', ...tags('Gapless B', 'Gapless', 'Gapless'), '-metadata', 'track=2',
  ]);
  // Loudness tags the player should apply (a quiet and a loud file with opposite gains).
  ffmpeg('replaygain-quiet.flac', join(d, 'replaygain', 'quiet.flac'), [
    ...tone(440, 10), '-af', 'volume=-18dB', '-c:a', 'flac', ...tags('Quiet', 'ReplayGain'),
    '-metadata', 'REPLAYGAIN_TRACK_GAIN=+12.00 dB', '-metadata', 'REPLAYGAIN_TRACK_PEAK=0.1',
  ]);
  ffmpeg('replaygain-loud.flac', join(d, 'replaygain', 'loud.flac'), [
    ...tone(440, 10), '-af', 'volume=-3dB', '-c:a', 'flac', ...tags('Loud', 'ReplayGain'),
    '-metadata', 'REPLAYGAIN_TRACK_GAIN=-3.00 dB', '-metadata', 'REPLAYGAIN_TRACK_PEAK=0.7',
  ]);
}

function video(): void {
  const d = join(out, 'video');
  const clip = (file: string, vcodec: string[], acodec: string[]) =>
    ffmpeg(file, join(d, file), [...picture(10), ...tone(440, 10), ...vcodec, ...acodec, '-shortest']);
  clip('h264.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac']);
  clip('h264-10bit.mkv', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p10le'], ['-c:a', 'flac']);
  clip('hevc.mp4', ['-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'], ['-c:a', 'aac']);
  clip('hevc-10bit.mkv', ['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le'], ['-c:a', 'libopus']);
  clip('vp9.webm', ['-c:v', 'libvpx-vp9', '-b:v', '1M'], ['-c:a', 'libopus']);
  clip('av1.mkv', ['-c:v', 'libsvtav1', '-pix_fmt', 'yuv420p'], ['-c:a', 'libopus']);
  clip('mpeg4.avi', ['-c:v', 'mpeg4', '-q:v', '5'], ['-c:a', 'libmp3lame']);
  clip('h264.mov', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac']);
  clip('h264.ts', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac']);
  clip('h264-ac3.mkv', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'ac3']);
  ffmpeg('portrait.mp4', join(d, 'portrait.mp4'), [
    ...picture(10, '360x640'), ...tone(440, 10), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ]);
}

const srt = (lines: string[]) =>
  lines.map((t, i) => `${i + 1}\n00:00:0${i * 3},000 --> 00:00:0${i * 3 + 2},500\n${t}\n`).join('\n');

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1
Style: Top,Arial,24,&H0000FFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,8,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.50,Default,,0,0,0,,{\\an2\\i1}ASS bottom line
Dialogue: 0,0:00:03.00,0:00:05.50,Top,,0,0,0,,{\\pos(320,60)\\c&H00FF00&}ASS positioned and coloured
Dialogue: 0,0:00:06.00,0:00:08.50,Default,,0,0,0,,日本語の字幕 / Русский / العربية
`;

function tracks(): void {
  const d = join(out, 'tracks');
  mkdirSync(d, { recursive: true });
  const eng = join(d, 'subs-eng.srt');
  const spa = join(d, 'subs-spa.srt');
  const jpn = join(d, 'subs-jpn.ass');
  writeFileSync(eng, srt(['English one', 'English two', 'English three']), 'utf8');
  writeFileSync(spa, srt(['Español uno', 'Español dos', 'Español tres']), 'utf8');
  writeFileSync(jpn, ass, 'utf8');
  // Three audio tracks (each a different tone so the active one is audible) and three embedded subtitles.
  ffmpeg('multi-track.mkv', join(d, 'multi-track.mkv'), [
    ...picture(10), ...tone(440, 10), ...tone(880, 10), ...tone(1320, 10), '-i', eng, '-i', spa, '-i', jpn,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map', '4', '-map', '5', '-map', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s:0', 'srt', '-c:s:1', 'srt', '-c:s:2', 'ass',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English 440 Hz',
    '-metadata:s:a:1', 'language=spa', '-metadata:s:a:1', 'title=Español 880 Hz',
    '-metadata:s:a:2', 'language=jpn', '-metadata:s:a:2', 'title=日本語 1320 Hz',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=spa', '-metadata:s:s:2', 'language=jpn',
    '-disposition:a:0', 'default', '-disposition:s:0', '0',
    // -shortest hangs when subtitle files are inputs, so the length is fixed instead.
    '-t', '10',
  ]);
  // The same clip with external subtitles beside it, named the way players look for them.
  ffmpeg('external-subs.mp4', join(d, 'external-subs.mp4'), [
    ...picture(10), ...tone(440, 10), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ]);
  writeFileSync(join(d, 'external-subs.en.srt'), srt(['External English', 'Second line', 'Third line']), 'utf8');
  writeFileSync(join(d, 'external-subs.es.srt'), srt(['Externo español', 'Segunda línea', 'Tercera línea']), 'utf8');
  // Chapters through an ffmetadata file.
  const meta = join(d, 'chapters.ffmetadata');
  writeFileSync(meta, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000\nEND=10000\ntitle=Main\n', 'utf8');
  ffmpeg('chapters.mkv', join(d, 'chapters.mkv'), [
    ...picture(10), ...tone(440, 10), '-i', meta, '-map_metadata', '2', '-map_chapters', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ]);
}

// File names in many scripts, with tags in the same script: where scanning and display break.
function names(): void {
  const d = join(out, 'names');
  const sets: [string, string, string][] = [
    ['日本語の曲.mp3', '日本語の曲', 'アーティスト'],
    ['Русская песня.flac', 'Русская песня', 'Исполнитель'],
    ['أغنية عربية.m4a', 'أغنية عربية', 'فنان'],
    ['한국어 노래.opus', '한국어 노래', '아티스트'],
    ['Ελληνικό τραγούδι.ogg', 'Ελληνικό τραγούδι', 'Καλλιτέχνης'],
    ['Chanson française – été.mp3', 'Chanson française – été', 'Édith'],
    ['Canzone italiana (città).mp3', 'Canzone italiana (città)', 'Àlessia'],
    ['Canción española ñandú.mp3', 'Canción española ñandú', 'Niño'],
    ['emoji 🎵 and spaces   .mp3', 'Emoji 🎵', 'Spaces'],
  ];
  for (const [file, title, artist] of sets) {
    const ext = file.split('.').pop()!;
    const codec = { mp3: ['-c:a', 'libmp3lame'], flac: ['-c:a', 'flac'], m4a: ['-c:a', 'aac'], opus: ['-c:a', 'libopus'], ogg: ['-c:a', 'libvorbis'] }[ext]!;
    ffmpeg(file, join(d, file), [...tone(440, 5), ...codec, ...tags(title, artist, title)]);
  }
}

function series(): void {
  for (let e = 1; e <= 3; e++) {
    const ep = String(e).padStart(2, '0');
    ffmpeg(`Test.Show.S01E${ep}`, join(out, 'series', 'Test Show', 'Season 1', `Test.Show.S01E${ep}.720p.mkv`), [
      ...picture(5, '1280x720'), ...tone(440 + e * 100, 5), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    ]);
  }
  ffmpeg('Some Movie (2001)', join(out, 'series', 'Some Movie (2001)', 'Some Movie (2001).mp4'), [
    ...picture(5), ...tone(440, 5), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ]);
}

const groups: Record<string, () => void> = { audio, video, tracks, names, series };
for (const [key, run] of Object.entries(groups)) if (!only || only === key) run();

for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? ` (${(r.size! / 1024).toFixed(0)} KB)` : `: ${r.note}`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} files made${failed ? `, ${failed} failed` : ''}.`);
process.exit(failed ? 1 : 0);
