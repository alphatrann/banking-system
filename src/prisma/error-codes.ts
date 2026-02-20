import { Prisma } from '@prisma/client';

export enum PostgresErrorCode {
  RecordNotFound = 'P2025',
  UniqueConstraintViolation = 'P2002',
  ForeignViolation = 'P2003',
  SerializationError = 'P2034',
}

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
