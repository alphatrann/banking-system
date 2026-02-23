import { Inject } from '@nestjs/common';

export const MINIO = Symbol('MinIO');

export function InjectMinio(): ParameterDecorator {
  return Inject(MINIO);
}
