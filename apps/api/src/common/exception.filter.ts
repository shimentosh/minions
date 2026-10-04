import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";

/**
 * Error responses carry a status, a short message and optionally a code.
 * Never the request body, never a stack, never a validation value (which
 * could be a secret), never a database error.
 */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Error");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message: string | string[] = exception.message;
      let code: string | undefined;
      if (typeof body === "object" && body) {
        const b = body as { message?: string | string[]; code?: string };
        if (b.message) message = b.message;
        code = b.code;
      }
      res.status(status).json({ statusCode: status, message, ...(code ? { code } : {}) });
      return;
    }
    // Log the type and message only; Prisma errors can include query values.
    const name = exception instanceof Error ? exception.name : "UnknownError";
    const code = (exception as { code?: string })?.code;
    this.logger.error(`${name}${code ? ` (${code})` : ""}`);
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, message: "Internal server error" });
  }
}
