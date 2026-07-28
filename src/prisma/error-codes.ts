import { Prisma } from '@prisma/client';

export const PostgresErrorCode = {
  RecordNotFound: 'P2025',
  UniqueConstraintViolation: 'P2002',
  ForeignViolation: 'P2003',
  SerializationError: 'P2034',
} as const;

export function isUniqueViolation(error: any) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PostgresErrorCode.UniqueConstraintViolation
  );
}

export function isForeignKeyViolation(error: any) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PostgresErrorCode.ForeignViolation
  );
}

export function isRecordNotFound(error: any) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PostgresErrorCode.RecordNotFound
  );
}

export function isSerializationFailure(error: any) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PostgresErrorCode.SerializationError
  );
}
