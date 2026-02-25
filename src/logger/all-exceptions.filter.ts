import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';
import { Request } from 'express';

@Catch()
export class AllExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request: Request = ctx.getRequest();

    const span = trace.getSpan(context.active());
    const traceId = span?.spanContext().traceId;
    this.logger.error({
      message: `Error ${request.method} ${request.path}`,
      method: request.method,
      path: request.path,
      traceId,
      error: exception instanceof Error ? exception.stack : undefined,
    });
  }
}
