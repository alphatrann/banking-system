import crypto from 'crypto';
const TOTAL_LENGTH = 20;

function makeSlug(length: number): string {
  const validChars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const randomBytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += validChars[randomBytes[i]! % validChars.length];
  }
  return result;
}

export function generateId(prefix: string): string {
  const slugLength = TOTAL_LENGTH - prefix.length - 1;
  return `${prefix}_${makeSlug(slugLength)}`;
}
