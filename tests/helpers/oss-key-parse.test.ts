import { describe, expect, it } from 'vitest';

import { parseThumbnailOssKey, parseVideoOssKey } from '../../src/helpers/oss-key-parse';
import { ApiError } from '../../src/utils/apiError';
import { planExerciseId, studentId, validThumbnailKey, validVideoKey } from '../helpers/video';

function expectOwnershipError(fn: () => unknown): void {
  expect(fn).toThrow(ApiError);
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code: 'UPLOAD_OSS_KEY_OWNERSHIP', status: 403 });
  }
}

describe('OSS key parsing', () => {
  it('parses strict video and thumbnail OSS keys', () => {
    expect(parseVideoOssKey(validVideoKey())).toEqual({
      studentId,
      planExerciseId,
      setIndex: 0,
    });
    expect(parseThumbnailOssKey(validThumbnailKey())).toEqual({
      studentId,
      planExerciseId,
      setIndex: 0,
    });
  });

  it.each([
    `students/${studentId}/../10000000-0000-4000-8000-000000000004/sets/${planExerciseId}/0/30000000-0000-4000-8000-000000000001.mp4`,
    `students/${studentId}/sets/${planExerciseId}%2F0/30000000-0000-4000-8000-000000000001.mp4`,
    `students/${studentId}/thumbs/${planExerciseId}/0/30000000-0000-4000-8000-000000000001.mp4`,
    `students/${studentId}/sets/${planExerciseId}/0/30000000-0000-4000-8000-000000000001.jpg`,
    `students/${studentId}/sets/${planExerciseId}/100/30000000-0000-4000-8000-000000000001.mp4`,
    `students/${studentId}/sets/not-uuid/0/30000000-0000-4000-8000-000000000001.mp4`,
    `students/------------------------------------/sets/${planExerciseId}/0/30000000-0000-4000-8000-000000000001.mp4`,
    `students/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sets/${planExerciseId}/0/30000000-0000-4000-8000-000000000001.mp4`,
    `students/12345678-1234-1234-1234-12345678901z/sets/${planExerciseId}/0/30000000-0000-4000-8000-000000000001.mp4`,
    `students/12345678-1234-1234-12345-1234567890ab/sets/${planExerciseId}/0/30000000-0000-4000-8000-000000000001.mp4`,
  ])('rejects unsafe video key %s', (key) => {
    expectOwnershipError(() => parseVideoOssKey(key));
  });

  it('keeps video and thumbnail prefixes separate', () => {
    expectOwnershipError(() => parseVideoOssKey(validThumbnailKey()));
    expectOwnershipError(() => parseThumbnailOssKey(validVideoKey()));
  });
});
