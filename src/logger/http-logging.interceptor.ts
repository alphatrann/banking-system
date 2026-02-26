import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  type LoggerService,
} from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';
import { Request } from 'express';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { catchError, Observable, tap } from 'rxjs';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private logger: LoggerService,
  ) {}

  intercept(
    excContext: ExecutionContext,
    next: CallHandler<any>,
  ): Observable<any> {
    const request: Request = excContext.switchToHttp().getRequest();
    const { method, path } = request;
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const span = trace.getSpan(context.active());
        const traceId = span?.spanContext().traceId;
        this.logger.log('http.success', {
          component: 'api',
          method,
          path,
          duration: Date.now() - now,
          traceId,
        });
      }),
      catchError((err) => {
        const span = trace.getSpan(context.active());
        const traceId = span?.spanContext().traceId;
        this.logger.error('http.error', {
          component: 'api',
          method,
          path,
          duration: Date.now() - now,
          traceId,
          error: err.message,
        });
        throw err;
      }),
    );
  }
}
