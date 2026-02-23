import { createHash, createHmac } from 'crypto';

export function hash(data: string) {
  return createHash('sha256').update(data).digest('hex');
}

export function hmac(data: string, secret: string) {
  return createHmac('sha256', secret).update(data).digest('hex');
}
