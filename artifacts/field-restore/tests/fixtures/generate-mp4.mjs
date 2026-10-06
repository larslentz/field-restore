// Regenerate the small synthetic fixtures with locally installed ffmpeg.
// There is no ffmpeg dependency in the app or installer.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const out = (name) => fileURLToPath(new URL(name, import.meta.url));
const video = ['-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=10:d=2'];
const audio = ['-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):s=48000:d=2'];
const ffmpeg = (args, name) => execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', ...args, '-movflags', '+faststart', '-y', out(name),
]);
ffmpeg([...video, ...audio, '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '96k'], 'mp4-aac-stereo.mp4');
ffmpeg([...audio, '-c:a', 'aac', '-b:a', '96k'], 'mp4-audio-only.mp4');
ffmpeg([...video, '-c:v', 'mpeg4', '-q:v', '5'], 'mp4-no-audio.mp4');
ffmpeg(['-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*440*t)|0.25*sin(2*PI*660*t)|0.25*sin(2*PI*880*t):s=48000:d=0.2',
  '-c:a', 'aac', '-b:a', '96k'], 'mp4-multichannel.mp4');
