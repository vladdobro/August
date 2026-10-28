import path from 'node:path';

/// Upload formats the dropzone accepts (AUG-144). Mirrored by ACCEPTED_EXTENSIONS in client/src/components/FileUpload.tsx —
/// keep both lists identical (mediaFormats.test.ts checks it). Browser recordings (.webm/.ogg/.mp4) reach the same
/// endpoint under generated names, so the server does not reject by extension.
export const AUDIO_UPLOAD_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.m4a'] as const;
export const VIDEO_UPLOAD_EXTENSIONS = ['.mp4', '.mov'] as const;
export const UPLOAD_EXTENSIONS: readonly string[] = [...AUDIO_UPLOAD_EXTENSIONS, ...VIDEO_UPLOAD_EXTENSIONS];

export function isAcceptedUploadName(name: string): boolean {
  const lower = name.toLowerCase();
  return UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/// Video containers: ffmpeg drops the video stream (-vn) and the audio track is probed first.
export function isVideoContainer(filePath: string): boolean {
  return (VIDEO_UPLOAD_EXTENSIONS as readonly string[]).includes(path.extname(filePath).toLowerCase());
}

export const VIDEO_NO_AUDIO_MESSAGE = 'The video has no audio track — nothing to transcribe.';
export const VIDEO_UNREADABLE_MESSAGE = 'Could not read video file — it may be corrupt or incomplete.';

export type VideoProbeResult = 'ok' | 'no-audio' | 'unreadable' | 'missing-ffprobe';

/// Classifies `ffprobe -select_streams a -show_entries stream=index` output: an error exit means the container could not
/// be read (ENOENT = ffprobe itself is missing), empty stdout means no audio stream.
export function classifyVideoProbe(error: { code?: string | number | null } | null, stdout: string): VideoProbeResult {
  if (error) return error.code === 'ENOENT' ? 'missing-ffprobe' : 'unreadable';
  return stdout.trim() === '' ? 'no-audio' : 'ok';
}
