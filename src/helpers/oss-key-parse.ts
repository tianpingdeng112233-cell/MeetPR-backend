import { ApiError } from '../utils/apiError';

const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;

const VIDEO_OSS_KEY_RE = new RegExp(
  String.raw`^students\/(?<studentId>${UUID})\/sets\/(?<planExerciseId>${UUID})\/(?<setIndex>\d{1,2})\/(?<filename>${UUID}\.(?:mp4|mov))$`,
);

const THUMBNAIL_OSS_KEY_RE = new RegExp(
  String.raw`^students\/(?<studentId>${UUID})\/thumbs\/(?<planExerciseId>${UUID})\/(?<setIndex>\d{1,2})\/(?<filename>${UUID}\.jpg)$`,
);

export interface ParsedVideoOssKey {
  studentId: string;
  planExerciseId: string;
  setIndex: number;
}

export interface ParsedThumbnailOssKey {
  studentId: string;
  planExerciseId: string;
  setIndex: number;
}

function parseWithRegex(key: string, regex: RegExp): ParsedVideoOssKey {
  const match = regex.exec(key);
  const groups = match?.groups;
  if (!groups?.studentId || !groups.planExerciseId || !groups.setIndex) {
    throw new ApiError('UPLOAD_OSS_KEY_OWNERSHIP', 403);
  }

  return {
    studentId: groups.studentId,
    planExerciseId: groups.planExerciseId,
    setIndex: Number.parseInt(groups.setIndex, 10),
  };
}

export function parseVideoOssKey(key: string): ParsedVideoOssKey {
  return parseWithRegex(key, VIDEO_OSS_KEY_RE);
}

export function parseThumbnailOssKey(key: string): ParsedThumbnailOssKey {
  return parseWithRegex(key, THUMBNAIL_OSS_KEY_RE);
}
