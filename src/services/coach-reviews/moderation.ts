/** Pure publication policy; the caller supplies the current database word list. */
export function moderateCoachReview(body: string, words: readonly string[]) {
  const text = body.normalize('NFKC');
  if (/(?<!\d)1\d{10}(?!\d)/u.test(text)) return 'phone';
  if (/(?:微信|微\s*信|wechat|wx|v信)\s*号?\s*[:：]?\s*[a-z\d_-]{3,}/iu.test(text)) return 'wechat';
  if (/qq\s*号?\s*[:：]?\s*\d{5,}/iu.test(text)) return 'qq';
  if (/(?:https?:\/\/|www\.|[a-z\d-]+\.(?:com|cn|net|org)\b)/iu.test(text)) return 'link';
  const folded = text.toLocaleLowerCase();
  if (
    words.some((word) => word.trim() && folded.includes(word.normalize('NFKC').toLocaleLowerCase()))
  )
    return 'blocked_word';
  return null;
}
