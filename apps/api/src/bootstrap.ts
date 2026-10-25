import { INestApplication, ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { loadConfig } from "./config";
import { PAGE_FILE_MAX_BYTES } from "./pages/limits";

/** Shared by main.ts and the integration tests, so tests run the real stack. */
export function configureApp(app: INestApplication) {
  const cfg = loadConfig();
  const express = app as NestExpressApplication;
  express.set("trust proxy", cfg.trustProxy);
  express.disable("x-powered-by");
  express.useBodyParser("json", { limit: "3mb" });
  // Encrypted page files (PUT /pages/:id/files/:fileId) arrive as raw ciphertext.
  express.useBodyParser("raw", { type: "application/octet-stream", limit: PAGE_FILE_MAX_BYTES });
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    }),
  );
  app.use(cookieParser());
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    // API responses can contain ciphertext and metadata; never cache them.
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.enableCors({
    credentials: true,
    allowedHeaders: ["content-type", "authorization", "x-minions-client", "x-minions-file-meta"],
    exposedHeaders: ["x-minions-file-meta"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return cb(null, true);
      if (cfg.webOrigins.includes(origin) || cfg.extensionOrigins.includes(origin))
        return cb(null, true);
      if (
        cfg.env !== "production" &&
        cfg.extensionOrigins.length === 0 &&
        origin.startsWith("chrome-extension://")
      )
        return cb(null, true);
      cb(null, false);
    },
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Validation errors name the property, never echo the value.
      validationError: { target: false, value: false },
    }),
  );
}
